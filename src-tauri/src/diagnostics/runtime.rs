use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    ai::{redact_sensitive_text, truncate_utf8},
    monitor::{
        manager::MonitorManager,
        models::{MetricState, MonitorSnapshot, utc_now_iso8601},
    },
    sftp::SftpManager,
    ssh::{
        DiagnosticSessionCommand, HostKeyIdentity, PortProtocol, ProcessSort, SessionManager,
        SessionSecurityBinding, SshErrorCode, SshState,
    },
};

use super::models::*;

const POLICY_VERSION: u32 = 1;
const PLAN_TTL: Duration = Duration::from_secs(120);
const GRANT_TTL: Duration = Duration::from_secs(60);
const MAX_PLAN_STEPS: usize = 6;
const MAX_STEP_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_TOTAL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_LOCAL_SELECTION_BYTES: usize = 16 * 1024;
const MAX_SERVICE_NAME_BYTES: usize = 128;
const MAX_PLANS: usize = 64;
const MAX_RUNS: usize = 16;

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum DiagnosticAction {
    SystemInfo,
    ResourceSnapshot,
    ProcessList {
        sort: ProcessSort,
        limit: u8,
    },
    ServiceInspect {
        service: String,
    },
    ListeningPorts {
        protocol: PortProtocol,
        limit: u8,
        port: Option<u16>,
    },
    RecentLogs {
        service: String,
        lines: u8,
    },
    FileExcerpt {
        remote_path: String,
    },
    TerminalSelection {
        text: String,
    },
}

impl DiagnosticAction {
    fn tool_id(&self) -> &'static str {
        match self {
            Self::SystemInfo => "host.system_info",
            Self::ResourceSnapshot => "host.resource_snapshot",
            Self::ProcessList { .. } => "process.list",
            Self::ServiceInspect { .. } => "service.inspect",
            Self::ListeningPorts { .. } => "network.listening_ports",
            Self::RecentLogs { .. } => "log.read_recent",
            Self::FileExcerpt { .. } => "file.read_excerpt",
            Self::TerminalSelection { .. } => "terminal.selection",
        }
    }

    fn is_linux_only(&self) -> bool {
        !matches!(self, Self::SystemInfo | Self::TerminalSelection { .. })
    }

    fn preview(&self, step_id: String, enabled: bool) -> DiagnosticStepPreview {
        let (title, why, sensitive_data, max_output_bytes) = match self {
            Self::SystemInfo => (
                "系统信息",
                "识别系统类型、主机名、运行时间和负载。",
                "主机名可能属于敏感基础设施信息。",
                2 * 1024,
            ),
            Self::ResourceSnapshot => (
                "资源快照",
                "查看内存、负载和文件系统使用情况；优先复用当前监控快照。",
                "挂载点名称可能暴露目录结构。",
                MAX_STEP_OUTPUT_BYTES,
            ),
            Self::ProcessList { .. } => (
                "进程列表",
                "查看资源占用靠前的进程，不读取进程环境变量或命令行参数。",
                "进程名和 PID 可能暴露运行服务。",
                MAX_STEP_OUTPUT_BYTES,
            ),
            Self::ServiceInspect { .. } => (
                "服务状态",
                "只读取指定 systemd 服务的状态字段。",
                "服务名与启动状态可能属于敏感运维信息。",
                4 * 1024,
            ),
            Self::ListeningPorts { .. } => (
                "监听端口",
                "枚举监听套接字；不读取进程详情，不需要 sudo。",
                "监听地址和端口可能属于敏感网络信息。",
                8 * 1024,
            ),
            Self::RecentLogs { .. } => (
                "近期日志",
                "读取该服务最新的有限行数，日志内容按不可信数据处理。",
                "日志可能含账号、路径或令牌；外发前将进行脱敏和人工预览。",
                MAX_STEP_OUTPUT_BYTES,
            ),
            Self::FileExcerpt { .. } => (
                "SFTP 文件摘录",
                "仅读取你刚才从 SFTP 选择的普通文本文件。",
                "文件内容可能含机密；外发必须再次单独确认。",
                MAX_STEP_OUTPUT_BYTES,
            ),
            Self::TerminalSelection { .. } => (
                "终端选区",
                "仅使用用户明确选中的终端文本，不读取终端历史缓冲区。",
                "选区作为不可信引用数据；发送模型前会单独预览。",
                MAX_LOCAL_SELECTION_BYTES,
            ),
        };
        let read_scope = match self {
            Self::ProcessList { sort, limit } => format!(
                "按 {} 排序，最多 {} 个进程",
                if *sort == ProcessSort::Cpu {
                    "CPU"
                } else {
                    "内存"
                },
                limit
            ),
            Self::ServiceInspect { service } => format!("systemctl show：{service}"),
            Self::RecentLogs { service, lines } => format!("journalctl：{service} 最近 {lines} 行"),
            Self::FileExcerpt { remote_path } => format!("{remote_path}，最多 16 KiB"),
            Self::TerminalSelection { text } => {
                format!("用户选中的文本，共 {} 字节（最多 16 KiB）", text.len())
            }
            Self::ListeningPorts { protocol, port, .. } => match port {
                Some(port) => format!(
                    "{} 监听端口，目标端口 {port}",
                    if *protocol == PortProtocol::Tcp {
                        "TCP"
                    } else {
                        "UDP"
                    }
                ),
                None => format!(
                    "最多 100 条 {} 监听项",
                    if *protocol == PortProtocol::Tcp {
                        "TCP"
                    } else {
                        "UDP"
                    }
                ),
            },
            Self::SystemInfo => "uname、hostname、uptime".to_owned(),
            Self::ResourceSnapshot => {
                "Monitor 快照，或 /proc/meminfo、/proc/loadavg、df -P -k".to_owned()
            }
        };
        let why = match self {
            Self::ProcessList { sort, .. } => format!(
                "查看资源占用靠前的{}进程，不读取环境变量或完整命令行。",
                if *sort == ProcessSort::Cpu {
                    " CPU "
                } else {
                    "内存 "
                }
            ),
            _ => why.to_owned(),
        };
        DiagnosticStepPreview {
            step_id,
            tool_id: self.tool_id().to_owned(),
            title: title.to_owned(),
            why,
            read_scope,
            max_output_bytes,
            sensitive_data: sensitive_data.to_owned(),
            enabled,
        }
    }
}

#[derive(Clone)]
struct StepRecord {
    preview: DiagnosticStepPreview,
    action: DiagnosticAction,
}

#[derive(Clone)]
struct PlanRecord {
    preview: DiagnosticPlanPreview,
    binding: SessionSecurityBinding,
    steps: Vec<StepRecord>,
    expires_epoch: u64,
}

#[derive(Clone)]
struct GrantRecord {
    plan_id: String,
    revision: u32,
    plan_hash: String,
    session_id: String,
    profile_id: String,
    host_key_identity: HostKeyIdentity,
    policy_version: u32,
    allowed_step_ids: Vec<String>,
    expires_epoch: u64,
}

#[derive(Clone)]
struct EvidenceRecord {
    preview: DiagnosticEvidencePreview,
    raw_content: String,
}

struct RunRecord {
    run_id: String,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    fingerprint_sha256: String,
    status: DiagnosticRunStatus,
    created_at: String,
    evidence: Vec<EvidenceRecord>,
    cancel: CancellationToken,
}

#[derive(Default)]
struct DiagnosticInner {
    plans: HashMap<String, PlanRecord>,
    grants: HashMap<String, GrantRecord>,
    runs: HashMap<String, Arc<Mutex<RunRecord>>>,
    active_by_session: HashMap<String, String>,
}

#[derive(Clone)]
pub struct DiagnosticRuntime {
    sessions: Arc<SessionManager>,
    monitor: Arc<MonitorManager>,
    sftp: Arc<SftpManager>,
    inner: Arc<Mutex<DiagnosticInner>>,
}

impl DiagnosticRuntime {
    pub fn new(
        sessions: Arc<SessionManager>,
        monitor: Arc<MonitorManager>,
        sftp: Arc<SftpManager>,
    ) -> Self {
        Self {
            sessions,
            monitor,
            sftp,
            inner: Arc::new(Mutex::new(DiagnosticInner::default())),
        }
    }

    pub fn templates() -> Vec<DiagnosticTemplateDescriptor> {
        vec![
            template(
                DiagnosticTemplateId::Nginx502,
                "Nginx 502",
                "检查 nginx 服务、近期日志、监听端口和主机资源。",
                false,
                false,
            ),
            template(
                DiagnosticTemplateId::ServiceFailed,
                "服务无法启动",
                "查看指定 systemd 服务状态、近期日志和进程列表。",
                true,
                false,
            ),
            template(
                DiagnosticTemplateId::DiskLow,
                "磁盘空间不足",
                "检查真实文件系统、内存和负载信息。",
                false,
                false,
            ),
            template(
                DiagnosticTemplateId::HighCpu,
                "CPU 负载高",
                "读取当前资源快照和 CPU 占用靠前的进程。",
                false,
                false,
            ),
            template(
                DiagnosticTemplateId::PortUnbound,
                "端口未监听",
                "检查指定 TCP/UDP 端口是否处于监听状态。",
                false,
                true,
            ),
            template(
                DiagnosticTemplateId::CurrentHost,
                "诊断当前服务器",
                "查看系统信息、资源、进程和监听端口。",
                false,
                false,
            ),
        ]
    }

    pub async fn create_plan(
        &self,
        request: DiagnosticPlanCreateRequest,
    ) -> Result<DiagnosticPlanPreview, DiagnosticError> {
        let binding = self.binding(&request.session_id).await?;
        let service = match request.template_id {
            DiagnosticTemplateId::Nginx502 => Some("nginx.service".to_owned()),
            DiagnosticTemplateId::ServiceFailed => Some(validate_service(
                request.service_name.as_deref().unwrap_or_default(),
            )?),
            _ => request
                .service_name
                .as_deref()
                .map(validate_service)
                .transpose()?,
        };
        if request.template_id == DiagnosticTemplateId::PortUnbound && request.port.is_none() {
            return Err(DiagnosticError::new(
                "missingPort",
                "请输入要检查的 TCP/UDP 端口。",
            ));
        }

        let mut actions = vec![DiagnosticAction::SystemInfo];
        let why = match request.template_id {
            DiagnosticTemplateId::Nginx502 => {
                actions.extend([
                    DiagnosticAction::ServiceInspect {
                        service: "nginx.service".to_owned(),
                    },
                    DiagnosticAction::RecentLogs {
                        service: "nginx.service".to_owned(),
                        lines: 100,
                    },
                    DiagnosticAction::ListeningPorts {
                        protocol: PortProtocol::Tcp,
                        limit: 100,
                        port: None,
                    },
                    DiagnosticAction::ResourceSnapshot,
                ]);
                "排查 Nginx 502：核对服务状态、最近 100 行日志、监听端口和主机资源。"
            }
            DiagnosticTemplateId::ServiceFailed => {
                let service = service.expect("服务失败模板已校验服务名");
                actions.extend([
                    DiagnosticAction::ServiceInspect {
                        service: service.clone(),
                    },
                    DiagnosticAction::RecentLogs {
                        service,
                        lines: 100,
                    },
                    DiagnosticAction::ProcessList {
                        sort: ProcessSort::Cpu,
                        limit: 20,
                    },
                ]);
                "检查指定 systemd 服务的只读状态、最近日志及进程列表。"
            }
            DiagnosticTemplateId::DiskLow => {
                actions.push(DiagnosticAction::ResourceSnapshot);
                "检查真实文件系统、内存和负载信息，确认空间使用情况。"
            }
            DiagnosticTemplateId::HighCpu => {
                actions.extend([
                    DiagnosticAction::ResourceSnapshot,
                    DiagnosticAction::ProcessList {
                        sort: ProcessSort::Cpu,
                        limit: 30,
                    },
                ]);
                "查看当前主机资源快照和 CPU 占用靠前的进程。"
            }
            DiagnosticTemplateId::PortUnbound => {
                actions.push(DiagnosticAction::ListeningPorts {
                    protocol: PortProtocol::Tcp,
                    limit: 100,
                    port: request.port,
                });
                "只检查指定 TCP 端口的监听状态；此模板不尝试连接或修改服务。"
            }
            DiagnosticTemplateId::CurrentHost => {
                actions.extend([
                    DiagnosticAction::ResourceSnapshot,
                    DiagnosticAction::ProcessList {
                        sort: ProcessSort::Memory,
                        limit: 20,
                    },
                    DiagnosticAction::ListeningPorts {
                        protocol: PortProtocol::Tcp,
                        limit: 50,
                        port: None,
                    },
                ]);
                "汇总当前服务器的系统、资源、进程和监听端口。"
            }
        };

        let mut context_summary = None;
        match request.selected_context {
            Some(DiagnosticSelectedContext::TerminalSelection { text }) => {
                if text.trim().is_empty() || text.len() > MAX_LOCAL_SELECTION_BYTES {
                    return Err(DiagnosticError::new(
                        "invalidSelection",
                        "终端选区为空或超过 16 KiB，请重新选择较短文本。",
                    ));
                }
                context_summary = Some(format!(
                    "已选中 {} 字节终端文本；只使用此选区。",
                    text.len()
                ));
                actions.push(DiagnosticAction::TerminalSelection { text });
            }
            Some(DiagnosticSelectedContext::SftpFile { remote_path }) => {
                if remote_path.trim().is_empty()
                    || remote_path.len() > 4096
                    || remote_path.contains('\0')
                    || remote_path.contains('\n')
                    || remote_path.contains('\r')
                {
                    return Err(DiagnosticError::new(
                        "invalidRemotePath",
                        "所选 SFTP 路径无效。",
                    ));
                }
                context_summary = Some(format!(
                    "已从 SFTP 选择文件：{remote_path}；审批后仅读取普通文本文件的前 16 KiB。"
                ));
                actions.push(DiagnosticAction::FileExcerpt { remote_path });
            }
            Some(DiagnosticSelectedContext::MonitorMetric { metric }) => {
                if !actions
                    .iter()
                    .any(|action| matches!(action, DiagnosticAction::ResourceSnapshot))
                {
                    actions.push(DiagnosticAction::ResourceSnapshot);
                }
                context_summary = Some(format!("从当前监控面板触发：{}。", metric_label(metric)));
            }
            None => {}
        }
        if actions.len() > MAX_PLAN_STEPS {
            return Err(DiagnosticError::new(
                "tooManySteps",
                "此诊断计划超过 6 步上限，请移除一个上下文来源。",
            ));
        }

        let now = epoch_seconds();
        let plan_id = Uuid::new_v4().to_string();
        let expires_epoch = now.saturating_add(PLAN_TTL.as_secs());
        let steps = actions
            .into_iter()
            .map(|action| {
                let step_id = Uuid::new_v4().to_string();
                StepRecord {
                    preview: action.preview(step_id, true),
                    action,
                }
            })
            .collect::<Vec<_>>();
        let mut preview = DiagnosticPlanPreview {
            plan_id: plan_id.clone(),
            revision: 1,
            plan_hash: String::new(),
            session_id: binding.summary.session_id.clone(),
            host: binding.summary.host.clone(),
            port: binding.summary.port,
            username: binding.summary.username.clone(),
            fingerprint_sha256: binding.identity.fingerprint_sha256.clone(),
            template_id: request.template_id,
            why: why.to_owned(),
            created_at: utc_now_iso8601(),
            expires_at: iso8601(expires_epoch),
            steps: steps.iter().map(|step| step.preview.clone()).collect(),
            context_summary,
        };
        preview.plan_hash = hash_plan(&preview, &binding, &steps)?;

        let mut inner = self.inner.lock().await;
        inner.plans.retain(|_, plan| plan.expires_epoch > now);
        inner.grants.retain(|_, grant| grant.expires_epoch > now);
        if inner.plans.len() >= MAX_PLANS {
            return Err(DiagnosticError::new(
                "tooManyPlans",
                "待审核诊断计划过多，请关闭旧计划后重试。",
            ));
        }
        inner.grants.retain(|_, grant| grant.plan_id != plan_id);
        inner.plans.insert(
            plan_id,
            PlanRecord {
                preview: preview.clone(),
                binding,
                steps,
                expires_epoch,
            },
        );
        Ok(preview)
    }

    pub async fn revise_plan(
        &self,
        request: DiagnosticPlanReviseRequest,
    ) -> Result<DiagnosticPlanPreview, DiagnosticError> {
        let mut inner = self.inner.lock().await;
        let mut record = inner
            .plans
            .get(&request.plan_id)
            .cloned()
            .ok_or_else(stale_plan_error)?;
        if record.expires_epoch <= epoch_seconds()
            || record.preview.revision != request.revision
            || !self.binding_matches(&record.binding).await
        {
            return Err(stale_plan_error());
        }
        let selected = request
            .selected_step_ids
            .into_iter()
            .collect::<HashSet<_>>();
        if selected.len() > MAX_PLAN_STEPS
            || selected
                .iter()
                .any(|id| !record.steps.iter().any(|step| step.preview.step_id == *id))
        {
            return Err(DiagnosticError::new(
                "invalidSteps",
                "所选步骤不属于当前诊断计划。",
            ));
        }
        for step in &mut record.steps {
            step.preview.enabled = selected.contains(&step.preview.step_id);
        }
        if record.steps.iter().all(|step| !step.preview.enabled) {
            return Err(DiagnosticError::new("emptyPlan", "至少保留一个诊断步骤。"));
        }
        record.preview.revision = record.preview.revision.saturating_add(1);
        record.preview.steps = record
            .steps
            .iter()
            .map(|step| step.preview.clone())
            .collect();
        record.preview.plan_hash = hash_plan(&record.preview, &record.binding, &record.steps)?;
        inner
            .grants
            .retain(|_, grant| grant.plan_id != request.plan_id);
        let result = record.preview.clone();
        inner.plans.insert(request.plan_id, record);
        Ok(result)
    }

    pub async fn approve_plan(
        &self,
        request: DiagnosticPlanApproveRequest,
    ) -> Result<DiagnosticGrantSummary, DiagnosticError> {
        let mut inner = self.inner.lock().await;
        let record = inner
            .plans
            .get(&request.plan_id)
            .cloned()
            .ok_or_else(stale_plan_error)?;
        let allowed_step_ids = record
            .steps
            .iter()
            .filter(|step| step.preview.enabled)
            .map(|step| step.preview.step_id.clone())
            .collect::<Vec<_>>();
        if record.expires_epoch <= epoch_seconds()
            || request.revision != record.preview.revision
            || request.displayed_hash != record.preview.plan_hash
            || request.selected_step_ids != allowed_step_ids
            || allowed_step_ids.is_empty()
            || !self.binding_matches(&record.binding).await
        {
            return Err(stale_plan_error());
        }
        let grant_id = Uuid::new_v4().to_string();
        let expires_epoch = epoch_seconds().saturating_add(GRANT_TTL.as_secs());
        let grant = GrantRecord {
            plan_id: request.plan_id.clone(),
            revision: record.preview.revision,
            plan_hash: record.preview.plan_hash.clone(),
            session_id: record.preview.session_id.clone(),
            profile_id: record.binding.summary.profile_id.clone(),
            host_key_identity: record.binding.identity.clone(),
            policy_version: POLICY_VERSION,
            allowed_step_ids: allowed_step_ids.clone(),
            expires_epoch,
        };
        inner
            .grants
            .retain(|_, existing| existing.plan_id != request.plan_id);
        inner.grants.insert(grant_id.clone(), grant);
        Ok(DiagnosticGrantSummary {
            grant_id,
            plan_id: request.plan_id,
            revision: record.preview.revision,
            expires_at: iso8601(expires_epoch),
            allowed_steps: allowed_step_ids.len(),
        })
    }

    pub async fn start(
        self: &Arc<Self>,
        plan_id: String,
        grant_id: String,
        on_event: Channel<DiagnosticEvent>,
    ) -> Result<String, DiagnosticError> {
        let mut inner = self.inner.lock().await;
        let grant = inner
            .grants
            .remove(&grant_id)
            .ok_or_else(stale_grant_error)?;
        let plan = inner
            .plans
            .get(&plan_id)
            .cloned()
            .ok_or_else(stale_grant_error)?;
        if !grant_matches_plan(&grant, &plan, epoch_seconds())
            || !self.binding_matches(&plan.binding).await
        {
            return Err(stale_grant_error());
        }
        if inner.active_by_session.contains_key(&grant.session_id) {
            return Err(DiagnosticError::new(
                "diagnosticBusy",
                "当前 SSH 会话已有只读诊断正在运行。",
            ));
        }
        let run_id = Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let run = Arc::new(Mutex::new(RunRecord {
            run_id: run_id.clone(),
            session_id: grant.session_id.clone(),
            host: plan.binding.summary.host.clone(),
            port: plan.binding.summary.port,
            username: plan.binding.summary.username.clone(),
            fingerprint_sha256: plan.binding.identity.fingerprint_sha256.clone(),
            status: DiagnosticRunStatus::Queued,
            created_at: utc_now_iso8601(),
            evidence: Vec::new(),
            cancel: cancel.clone(),
        }));
        inner
            .active_by_session
            .insert(grant.session_id.clone(), run_id.clone());
        inner.runs.insert(run_id.clone(), Arc::clone(&run));
        inner.plans.remove(&plan_id);
        cleanup_old_runs(&mut inner);
        drop(inner);

        let runtime = Arc::clone(self);
        let worker_run_id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            runtime.execute_plan(plan, run, cancel, on_event).await;
            let mut inner = runtime.inner.lock().await;
            inner
                .active_by_session
                .retain(|_, active_run_id| active_run_id != &worker_run_id);
        });
        Ok(run_id)
    }

    pub async fn cancel(&self, run_id: &str, session_id: &str) -> Result<bool, DiagnosticError> {
        let run = self.run_for_session(run_id, session_id).await?;
        let run = run.lock().await;
        if matches!(
            run.status,
            DiagnosticRunStatus::Queued | DiagnosticRunStatus::Running
        ) {
            run.cancel.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn get_run(
        &self,
        run_id: &str,
        session_id: &str,
    ) -> Result<DiagnosticRunSummary, DiagnosticError> {
        let run = self.run_for_session(run_id, session_id).await?;
        Ok(run_summary(&*run.lock().await))
    }

    pub async fn session_id_for_run(&self, run_id: &str) -> Option<String> {
        let run = self.inner.lock().await.runs.get(run_id).cloned()?;
        Some(run.lock().await.session_id.clone())
    }

    pub async fn share_data(
        &self,
        run_id: &str,
        evidence_ids: &[String],
    ) -> Result<DiagnosticShareData, DiagnosticError> {
        if evidence_ids.is_empty() || evidence_ids.len() > MAX_PLAN_STEPS {
            return Err(DiagnosticError::new(
                "invalidEvidence",
                "请选择 1 到 6 条诊断证据。",
            ));
        }
        let run = self
            .inner
            .lock()
            .await
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| DiagnosticError::new("runNotFound", "诊断记录不存在或已清理。"))?;
        let run = run.lock().await;
        if run.status != DiagnosticRunStatus::Completed {
            return Err(DiagnosticError::new(
                "runIncomplete",
                "诊断尚未完成，暂时不能生成报告。",
            ));
        }
        let binding = self.binding(&run.session_id).await?;
        if binding.summary.host != run.host
            || binding.identity.fingerprint_sha256 != run.fingerprint_sha256
        {
            return Err(DiagnosticError::new(
                "hostIdentityChanged",
                "主机身份已改变，旧诊断证据不能外发。",
            ));
        }
        let mut seen = HashSet::new();
        let mut evidence = Vec::with_capacity(evidence_ids.len());
        for evidence_id in evidence_ids {
            if !seen.insert(evidence_id) {
                return Err(DiagnosticError::new(
                    "invalidEvidence",
                    "诊断证据编号重复。",
                ));
            }
            let item = run
                .evidence
                .iter()
                .find(|item| item.preview.evidence_id == *evidence_id)
                .ok_or_else(|| {
                    DiagnosticError::new("invalidEvidence", "有证据不属于当前诊断记录。")
                })?;
            let (content, redacted) = redact_sensitive_text(&item.raw_content);
            evidence.push(DiagnosticShareEvidence {
                evidence_id: item.preview.evidence_id.clone(),
                tool_id: item.preview.tool_id.clone(),
                status: item.preview.status,
                source: item.preview.source.clone(),
                collected_at: item.preview.collected_at.clone(),
                command_template: item.preview.command_template.clone(),
                exit_status: item.preview.exit_status,
                elapsed_ms: item.preview.elapsed_ms,
                redacted,
                content,
            });
        }
        Ok(DiagnosticShareData {
            run_id: run.run_id.clone(),
            session_id: run.session_id.clone(),
            host: run.host.clone(),
            port: run.port,
            username: run.username.clone(),
            fingerprint_sha256: run.fingerprint_sha256.clone(),
            evidence,
        })
    }

    pub async fn close_session(&self, session_id: &str) {
        let mut inner = self.inner.lock().await;
        inner
            .plans
            .retain(|_, plan| plan.preview.session_id != session_id);
        inner
            .grants
            .retain(|_, grant| grant.session_id != session_id);
        inner.active_by_session.remove(session_id);
        let mut remove_ids = Vec::new();
        for (run_id, run) in &inner.runs {
            let record = run.lock().await;
            if record.session_id == session_id {
                record.cancel.cancel();
                remove_ids.push(run_id.clone());
            }
        }
        for run_id in remove_ids {
            inner.runs.remove(&run_id);
        }
    }

    pub async fn close_all(&self) {
        let mut inner = self.inner.lock().await;
        for run in inner.runs.values() {
            run.lock().await.cancel.cancel();
        }
        inner.plans.clear();
        inner.grants.clear();
        inner.active_by_session.clear();
        inner.runs.clear();
    }

    pub async fn watch_session(self: &Arc<Self>, session_id: String) {
        let Ok(mut termination) = self.sessions.termination_receiver(&session_id).await else {
            return;
        };
        let runtime = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                if *termination.borrow_and_update() != crate::ssh::SessionTermination::Running {
                    break;
                }
                if termination.changed().await.is_err() {
                    break;
                }
            }
            if let Some(runtime) = runtime.upgrade() {
                runtime.close_session(&session_id).await;
            }
        });
    }

    async fn execute_plan(
        &self,
        plan: PlanRecord,
        run: Arc<Mutex<RunRecord>>,
        cancel: CancellationToken,
        on_event: Channel<DiagnosticEvent>,
    ) {
        let (run_id, session_id) = {
            let mut record = run.lock().await;
            record.status = DiagnosticRunStatus::Running;
            (record.run_id.clone(), record.session_id.clone())
        };
        let _ = on_event.send(DiagnosticEvent::RunStatus {
            run_id: run_id.clone(),
            session_id: session_id.clone(),
            status: DiagnosticRunStatus::Running,
            message: None,
        });
        let mut linux_supported = None;
        let mut total_output = 0usize;
        let enabled_steps = plan
            .steps
            .iter()
            .filter(|step| step.preview.enabled)
            .cloned()
            .collect::<Vec<_>>();
        for (index, step) in enabled_steps.iter().enumerate() {
            if cancel.is_cancelled() {
                for pending in &enabled_steps[index..] {
                    let evidence = make_evidence(
                        &pending.preview,
                        EvidenceCapture {
                            status: DiagnosticStepStatus::NotRun,
                            source: "本地调度".to_owned(),
                            command_template: None,
                            exit_status: None,
                            elapsed_ms: 0,
                            raw_content: "已取消，未执行此步骤。".to_owned(),
                            truncated: false,
                        },
                    );
                    append_evidence(&run, evidence.clone()).await;
                    let _ = on_event.send(step_finished_event(
                        &run_id,
                        &session_id,
                        pending,
                        &evidence,
                    ));
                }
                break;
            }
            let _ = on_event.send(DiagnosticEvent::StepStarted {
                run_id: run_id.clone(),
                session_id: session_id.clone(),
                step_id: step.preview.step_id.clone(),
                tool_id: step.preview.tool_id.clone(),
            });
            let started = std::time::Instant::now();
            let (status, source, command_template, exit_status, mut content, truncated) =
                if step.action.is_linux_only() && linux_supported == Some(false) {
                    (
                        DiagnosticStepStatus::Unsupported,
                        "本机调度".to_owned(),
                        None,
                        None,
                        "当前服务器不是 Linux；此只读工具未运行。".to_owned(),
                        false,
                    )
                } else {
                    self.collect_step(&step.action, &session_id, &cancel, &mut linux_supported)
                        .await
                };
            let elapsed = started.elapsed().as_millis();
            let original_bytes = content.len();
            if total_output.saturating_add(original_bytes) > MAX_TOTAL_OUTPUT_BYTES {
                content = "整份诊断输出已达到 64 KiB 上限；此步骤结果未保留。".to_owned();
                let evidence = make_evidence(
                    &step.preview,
                    EvidenceCapture {
                        status: DiagnosticStepStatus::NotRun,
                        source: source.clone(),
                        command_template: command_template.clone(),
                        exit_status,
                        elapsed_ms: elapsed,
                        raw_content: content,
                        truncated: false,
                    },
                );
                append_evidence(&run, evidence.clone()).await;
                let _ = on_event.send(step_finished_event(&run_id, &session_id, step, &evidence));
                for pending in &enabled_steps[index + 1..] {
                    let evidence = make_evidence(
                        &pending.preview,
                        EvidenceCapture {
                            status: DiagnosticStepStatus::NotRun,
                            source: "本地调度".to_owned(),
                            command_template: None,
                            exit_status: None,
                            elapsed_ms: 0,
                            raw_content: "已达到整份诊断的 64 KiB 输出上限，未执行此步骤。"
                                .to_owned(),
                            truncated: false,
                        },
                    );
                    append_evidence(&run, evidence.clone()).await;
                    let _ = on_event.send(step_finished_event(
                        &run_id,
                        &session_id,
                        pending,
                        &evidence,
                    ));
                }
                break;
            }
            total_output = total_output.saturating_add(original_bytes);
            let evidence = make_evidence(
                &step.preview,
                EvidenceCapture {
                    status,
                    source,
                    command_template,
                    exit_status,
                    elapsed_ms: elapsed,
                    raw_content: content,
                    truncated,
                },
            );
            append_evidence(&run, evidence.clone()).await;
            let _ = on_event.send(step_finished_event(&run_id, &session_id, step, &evidence));
        }
        let final_status = if cancel.is_cancelled() {
            DiagnosticRunStatus::Cancelled
        } else {
            DiagnosticRunStatus::Completed
        };
        {
            let mut record = run.lock().await;
            record.status = final_status;
        }
        let _ = on_event.send(DiagnosticEvent::EvidenceReady {
            run_id: run_id.clone(),
            session_id: session_id.clone(),
            evidence_ids: run
                .lock()
                .await
                .evidence
                .iter()
                .map(|item| item.preview.evidence_id.clone())
                .collect(),
        });
        let message = if cancel.is_cancelled() {
            Some("已停止后续检查；当前远端命令可能需要服务器完成关闭。".to_owned())
        } else {
            None
        };
        let _ = on_event.send(DiagnosticEvent::RunStatus {
            run_id,
            session_id,
            status: final_status,
            message,
        });
    }

    async fn collect_step(
        &self,
        action: &DiagnosticAction,
        session_id: &str,
        cancel: &CancellationToken,
        linux_supported: &mut Option<bool>,
    ) -> (
        DiagnosticStepStatus,
        String,
        Option<String>,
        Option<u32>,
        String,
        bool,
    ) {
        match action {
            DiagnosticAction::TerminalSelection { text } => (
                DiagnosticStepStatus::Success,
                "本机终端选区".to_owned(),
                None,
                None,
                text.clone(),
                false,
            ),
            DiagnosticAction::ResourceSnapshot => {
                if let Some(snapshot) = self
                    .monitor
                    .snapshot(session_id)
                    .await
                    .filter(is_fresh_snapshot)
                {
                    let output = serde_json::to_string_pretty(&snapshot)
                        .unwrap_or_else(|_| "当前监控快照无法编码。".to_owned());
                    let (output, truncated) = truncate_utf8(&output, MAX_STEP_OUTPUT_BYTES);
                    return (
                        DiagnosticStepStatus::Success,
                        "MonitorManager 快照".to_owned(),
                        Some("MonitorManager::snapshot".to_owned()),
                        None,
                        output,
                        truncated,
                    );
                }
                self.exec_step(
                    session_id,
                    DiagnosticSessionCommand::ResourceSnapshot,
                    cancel,
                    linux_supported,
                )
                .await
            }
            DiagnosticAction::SystemInfo => {
                self.exec_step(
                    session_id,
                    DiagnosticSessionCommand::SystemInfo,
                    cancel,
                    linux_supported,
                )
                .await
            }
            DiagnosticAction::ProcessList { sort, limit } => {
                self.exec_step(
                    session_id,
                    DiagnosticSessionCommand::ProcessList {
                        sort: *sort,
                        limit: *limit,
                    },
                    cancel,
                    linux_supported,
                )
                .await
            }
            DiagnosticAction::ServiceInspect { service } => {
                self.exec_step(
                    session_id,
                    DiagnosticSessionCommand::ServiceInspect {
                        service: service.clone(),
                    },
                    cancel,
                    linux_supported,
                )
                .await
            }
            DiagnosticAction::ListeningPorts {
                protocol,
                limit,
                port,
            } => {
                self.exec_step(
                    session_id,
                    DiagnosticSessionCommand::ListeningPorts {
                        protocol: *protocol,
                        limit: *limit,
                        port: *port,
                    },
                    cancel,
                    linux_supported,
                )
                .await
            }
            DiagnosticAction::RecentLogs { service, lines } => {
                self.exec_step(
                    session_id,
                    DiagnosticSessionCommand::RecentLogs {
                        service: service.clone(),
                        lines: *lines,
                    },
                    cancel,
                    linux_supported,
                )
                .await
            }
            DiagnosticAction::FileExcerpt { remote_path } => {
                let result = tokio::select! {
                    _ = cancel.cancelled() => Err("诊断已取消；未读取所选文件。".to_owned()),
                    result = tokio::time::timeout(Duration::from_secs(8), self.sftp.read_text_for_ai(session_id, remote_path)) => match result {
                        Err(_) => Err("SFTP 文件读取超过 8 秒上限。".to_owned()),
                        Ok(Err(error)) => Err(error.message),
                        Ok(Ok(text)) => Ok(text),
                    }
                };
                match result {
                    Ok(text) => {
                        let (text, truncated) = truncate_utf8(&text, MAX_STEP_OUTPUT_BYTES);
                        (
                            DiagnosticStepStatus::Success,
                            "SFTP 安全文本读取".to_owned(),
                            Some("SftpManager::read_text_for_ai".to_owned()),
                            Some(0),
                            text,
                            truncated,
                        )
                    }
                    Err(message) if cancel.is_cancelled() => (
                        DiagnosticStepStatus::Cancelled,
                        "SFTP 安全文本读取".to_owned(),
                        Some("SftpManager::read_text_for_ai".to_owned()),
                        None,
                        message,
                        false,
                    ),
                    Err(message) if message.to_lowercase().contains("超时") => (
                        DiagnosticStepStatus::Timeout,
                        "SFTP 安全文本读取".to_owned(),
                        Some("SftpManager::read_text_for_ai".to_owned()),
                        None,
                        message,
                        false,
                    ),
                    Err(message) => (
                        DiagnosticStepStatus::Error,
                        "SFTP 安全文本读取".to_owned(),
                        Some("SftpManager::read_text_for_ai".to_owned()),
                        None,
                        message,
                        false,
                    ),
                }
            }
        }
    }

    async fn exec_step(
        &self,
        session_id: &str,
        command: DiagnosticSessionCommand,
        cancel: &CancellationToken,
        linux_supported: &mut Option<bool>,
    ) -> (
        DiagnosticStepStatus,
        String,
        Option<String>,
        Option<u32>,
        String,
        bool,
    ) {
        let command_text = match command.command() {
            Ok(command) => command,
            Err(error) => {
                return (
                    DiagnosticStepStatus::Error,
                    "SSH 诊断通道".to_owned(),
                    None,
                    None,
                    error.message,
                    false,
                );
            }
        };
        match self
            .sessions
            .exec_diagnostic(session_id, command, cancel.clone())
            .await
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                if command_text.contains("uname -srm") {
                    *linux_supported = Some(
                        stdout
                            .lines()
                            .any(|line| line.trim_start().starts_with("system=Linux")),
                    );
                }
                let mut content = stdout;
                if !output.stderr.is_empty() {
                    if !content.is_empty() {
                        content.push('\n');
                    }
                    content.push_str("[stderr]\n");
                    content.push_str(&String::from_utf8_lossy(&output.stderr));
                }
                let status = classify_exit(output.exit_status, &content);
                let (content, truncated) = truncate_utf8(&content, MAX_STEP_OUTPUT_BYTES);
                (
                    status,
                    "SSH 独立只读 exec 通道".to_owned(),
                    Some(command_template(&command_text)),
                    output.exit_status,
                    content,
                    truncated,
                )
            }
            Err(error) => {
                let status = match error.code {
                    SshErrorCode::Canceled => DiagnosticStepStatus::Cancelled,
                    SshErrorCode::ConnectionTimeout => DiagnosticStepStatus::Timeout,
                    SshErrorCode::SessionClosed | SshErrorCode::SessionNotFound => {
                        DiagnosticStepStatus::Error
                    }
                    _ if error.message.to_lowercase().contains("权限") => {
                        DiagnosticStepStatus::PermissionDenied
                    }
                    _ => DiagnosticStepStatus::Error,
                };
                (
                    status,
                    "SSH 独立只读 exec 通道".to_owned(),
                    Some(command_template(&command_text)),
                    None,
                    error.message,
                    false,
                )
            }
        }
    }

    async fn binding(&self, session_id: &str) -> Result<SessionSecurityBinding, DiagnosticError> {
        let binding = self
            .sessions
            .security_binding(session_id)
            .await
            .map_err(|_| {
                DiagnosticError::new(
                    "sessionUnavailable",
                    "当前 SSH 会话不存在或缺少已验证的主机身份，请先连接服务器。",
                )
            })?;
        if binding.summary.state != SshState::Connected {
            return Err(DiagnosticError::new(
                "sessionUnavailable",
                "当前 SSH 会话未连接，请先连接服务器。",
            ));
        }
        Ok(binding)
    }

    async fn binding_matches(&self, expected: &SessionSecurityBinding) -> bool {
        self.binding(&expected.summary.session_id)
            .await
            .is_ok_and(|actual| {
                actual.summary.session_id == expected.summary.session_id
                    && actual.summary.profile_id == expected.summary.profile_id
                    && actual
                        .summary
                        .host
                        .eq_ignore_ascii_case(&expected.summary.host)
                    && actual.summary.port == expected.summary.port
                    && actual.summary.username == expected.summary.username
                    && actual.identity == expected.identity
            })
    }

    async fn run_for_session(
        &self,
        run_id: &str,
        session_id: &str,
    ) -> Result<Arc<Mutex<RunRecord>>, DiagnosticError> {
        let run = self
            .inner
            .lock()
            .await
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| DiagnosticError::new("runNotFound", "诊断记录不存在或已清理。"))?;
        if run.lock().await.session_id != session_id {
            return Err(DiagnosticError::new(
                "sessionMismatch",
                "诊断记录不属于当前 SSH 会话。",
            ));
        }
        Ok(run)
    }
}

fn template(
    id: DiagnosticTemplateId,
    title: &str,
    description: &str,
    requires_service: bool,
    requires_port: bool,
) -> DiagnosticTemplateDescriptor {
    DiagnosticTemplateDescriptor {
        id,
        title: title.to_owned(),
        description: description.to_owned(),
        requires_service,
        requires_port,
    }
}

fn metric_label(metric: DiagnosticMetricId) -> &'static str {
    match metric {
        DiagnosticMetricId::Cpu => "CPU 指标",
        DiagnosticMetricId::Memory => "内存指标",
        DiagnosticMetricId::Disk => "磁盘指标",
        DiagnosticMetricId::Processes => "进程列表",
        DiagnosticMetricId::Network => "网络指标",
    }
}

fn validate_service(service: &str) -> Result<String, DiagnosticError> {
    if service.is_empty()
        || service.len() > MAX_SERVICE_NAME_BYTES
        || !service.as_bytes()[0].is_ascii_alphanumeric()
        || !service
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.@-".contains(&byte))
    {
        return Err(DiagnosticError::new(
            "invalidServiceName",
            "服务名只能包含字母、数字、点、下划线、@ 和连字符，且不能超过 128 字节。",
        ));
    }
    Ok(service.to_owned())
}

#[derive(Serialize)]
struct HashPayload<'a> {
    policy_version: u32,
    plan_id: &'a str,
    revision: u32,
    session_id: &'a str,
    profile_id: &'a str,
    host: &'a str,
    port: u16,
    username: &'a str,
    identity: &'a HostKeyIdentity,
    template_id: DiagnosticTemplateId,
    why: &'a str,
    created_at: &'a str,
    expires_at: &'a str,
    context_summary: &'a Option<String>,
    steps: Vec<(&'a DiagnosticStepPreview, &'a DiagnosticAction)>,
}

fn hash_plan(
    preview: &DiagnosticPlanPreview,
    binding: &SessionSecurityBinding,
    steps: &[StepRecord],
) -> Result<String, DiagnosticError> {
    let payload = HashPayload {
        policy_version: POLICY_VERSION,
        plan_id: &preview.plan_id,
        revision: preview.revision,
        session_id: &preview.session_id,
        profile_id: &binding.summary.profile_id,
        host: &binding.summary.host,
        port: binding.summary.port,
        username: &binding.summary.username,
        identity: &binding.identity,
        template_id: preview.template_id,
        why: &preview.why,
        created_at: &preview.created_at,
        expires_at: &preview.expires_at,
        context_summary: &preview.context_summary,
        steps: steps
            .iter()
            .map(|step| (&step.preview, &step.action))
            .collect(),
    };
    let bytes = serde_json::to_vec(&payload)
        .map_err(|_| DiagnosticError::new("planEncoding", "无法生成诊断计划指纹。"))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{digest:x}"))
}

fn validate_plan_steps(record: &PlanRecord) -> bool {
    record.steps.len() <= MAX_PLAN_STEPS
        && record
            .steps
            .iter()
            .all(|step| step.preview.max_output_bytes <= MAX_STEP_OUTPUT_BYTES)
        && record.steps.iter().any(|step| step.preview.enabled)
}

fn grant_matches_plan(grant: &GrantRecord, plan: &PlanRecord, now: u64) -> bool {
    grant.plan_id == plan.preview.plan_id
        && grant.expires_epoch > now
        && plan.expires_epoch > now
        && grant.revision == plan.preview.revision
        && grant.plan_hash == plan.preview.plan_hash
        && grant.session_id == plan.preview.session_id
        && grant.profile_id == plan.binding.summary.profile_id
        && grant.host_key_identity == plan.binding.identity
        && grant.policy_version == POLICY_VERSION
        && grant.allowed_step_ids
            == plan
                .steps
                .iter()
                .filter(|step| step.preview.enabled)
                .map(|step| step.preview.step_id.clone())
                .collect::<Vec<_>>()
        && validate_plan_steps(plan)
}

fn stale_plan_error() -> DiagnosticError {
    DiagnosticError::new(
        "planStale",
        "诊断计划已过期、被修改或 SSH 主机身份已变化，请重新生成并审核。",
    )
}

fn stale_grant_error() -> DiagnosticError {
    DiagnosticError::new(
        "grantInvalid",
        "诊断授权已过期、已使用或与当前计划/会话不匹配，请重新审核。",
    )
}

fn epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn iso8601(timestamp: u64) -> String {
    let days = (timestamp / 86_400) as i64;
    let second_of_day = timestamp % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = second_of_day / 3_600;
    let minute = second_of_day % 3_600 / 60;
    let second = second_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn is_fresh_snapshot(snapshot: &MonitorSnapshot) -> bool {
    snapshot.sequence > 0
        && snapshot.host.state == MetricState::Fresh
        && !snapshot.session_id.is_empty()
}

fn classify_exit(exit_status: Option<u32>, output: &str) -> DiagnosticStepStatus {
    if exit_status == Some(0) {
        return DiagnosticStepStatus::Success;
    }
    let normalized = output.to_lowercase();
    if normalized.contains("permission denied")
        || normalized.contains("access denied")
        || normalized.contains("权限不足")
    {
        DiagnosticStepStatus::PermissionDenied
    } else if normalized.contains("command not found")
        || normalized.contains("not found")
        || exit_status == Some(127)
    {
        DiagnosticStepStatus::Unsupported
    } else {
        DiagnosticStepStatus::Error
    }
}

fn command_template(command: &str) -> String {
    match command {
        _ if command.contains("uname -srm") => "host.system_info/v1".to_owned(),
        _ if command.contains("/proc/meminfo") => {
            "host.resource_snapshot/linux-procfs-v1".to_owned()
        }
        _ if command.contains("ps -eo") => "process.list/linux-ps-v1".to_owned(),
        _ if command.contains("systemctl show") => "service.inspect/systemd-show-v1".to_owned(),
        _ if command.contains("ss ") => "network.listening_ports/linux-ss-v1".to_owned(),
        _ if command.contains("journalctl") => "log.read_recent/journalctl-v1".to_owned(),
        _ => "diagnostic.fixed-template/v1".to_owned(),
    }
}

struct EvidenceCapture {
    status: DiagnosticStepStatus,
    source: String,
    command_template: Option<String>,
    exit_status: Option<u32>,
    elapsed_ms: u128,
    raw_content: String,
    truncated: bool,
}

fn make_evidence(step: &DiagnosticStepPreview, capture: EvidenceCapture) -> EvidenceRecord {
    let EvidenceCapture {
        status,
        source,
        command_template,
        exit_status,
        elapsed_ms,
        raw_content,
        truncated,
    } = capture;
    let original_bytes = raw_content.len();
    let (safe_preview, _) = redact_sensitive_text(&raw_content);
    EvidenceRecord {
        preview: DiagnosticEvidencePreview {
            evidence_id: format!("ev-{}", Uuid::new_v4()),
            tool_id: step.tool_id.clone(),
            status,
            source,
            collected_at: utc_now_iso8601(),
            command_template,
            exit_status,
            elapsed_ms,
            original_bytes,
            truncated,
            safe_preview,
        },
        raw_content,
    }
}

async fn append_evidence(run: &Mutex<RunRecord>, evidence: EvidenceRecord) {
    run.lock().await.evidence.push(evidence);
}

fn step_finished_event(
    run_id: &str,
    session_id: &str,
    step: &StepRecord,
    evidence: &EvidenceRecord,
) -> DiagnosticEvent {
    DiagnosticEvent::StepFinished {
        run_id: run_id.to_owned(),
        session_id: session_id.to_owned(),
        step_id: step.preview.step_id.clone(),
        tool_id: step.preview.tool_id.clone(),
        status: evidence.preview.status,
        elapsed_ms: evidence.preview.elapsed_ms,
        evidence_id: Some(evidence.preview.evidence_id.clone()),
        message: None,
    }
}

fn run_summary(run: &RunRecord) -> DiagnosticRunSummary {
    DiagnosticRunSummary {
        run_id: run.run_id.clone(),
        session_id: run.session_id.clone(),
        host: run.host.clone(),
        port: run.port,
        username: run.username.clone(),
        fingerprint_sha256: run.fingerprint_sha256.clone(),
        status: run.status,
        created_at: run.created_at.clone(),
        evidence: run
            .evidence
            .iter()
            .map(|item| item.preview.clone())
            .collect(),
    }
}

fn cleanup_old_runs(inner: &mut DiagnosticInner) {
    if inner.runs.len() <= MAX_RUNS {
        return;
    }
    let mut runs = inner
        .runs
        .iter()
        .filter_map(|(id, run)| {
            run.try_lock()
                .ok()
                .map(|record| (id.clone(), record.created_at.clone(), record.status))
        })
        .collect::<Vec<_>>();
    runs.sort_by(|left, right| left.1.cmp(&right.1));
    for (id, _, status) in runs {
        if inner.runs.len() <= MAX_RUNS {
            break;
        }
        if status != DiagnosticRunStatus::Running
            && !inner.active_by_session.values().any(|active| active == &id)
        {
            inner.runs.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DiagnosticAction, DiagnosticMetricId, DiagnosticTemplateId, GrantRecord, POLICY_VERSION,
        PlanRecord, StepRecord, epoch_seconds, grant_matches_plan, hash_plan, iso8601,
        validate_service,
    };
    use crate::ssh::{
        HostKeyIdentity, PortProtocol, ProcessSort, SessionSecurityBinding, SessionSummary,
        SshState,
    };

    #[test]
    fn templates_have_a_fixed_read_only_catalog() {
        assert_eq!(
            DiagnosticTemplateId::Nginx502,
            DiagnosticTemplateId::Nginx502
        );
        let command = DiagnosticAction::ProcessList {
            sort: ProcessSort::Cpu,
            limit: 30,
        };
        assert!(
            command
                .preview("step".to_owned(), true)
                .read_scope
                .contains("30")
        );
        let port = DiagnosticAction::ListeningPorts {
            protocol: PortProtocol::Tcp,
            limit: 100,
            port: Some(443),
        };
        assert!(
            port.preview("step".to_owned(), true)
                .read_scope
                .contains("443")
        );
        assert_eq!(super::metric_label(DiagnosticMetricId::Cpu), "CPU 指标");
    }

    #[test]
    fn system_info_can_run_on_other_unix_hosts_but_linux_tools_cannot() {
        assert!(!DiagnosticAction::SystemInfo.is_linux_only());
        assert!(DiagnosticAction::ResourceSnapshot.is_linux_only());
        let scope = DiagnosticAction::SystemInfo
            .preview("step".to_owned(), true)
            .read_scope;
        assert!(scope.contains("uptime"));
        assert!(!scope.contains("/proc"));
    }

    #[test]
    fn systemd_unit_rejects_shell_metacharacters() {
        for invalid in ["; id", "foo\nbar", "$(touch /tmp/x)", "-rf", "../nginx"] {
            assert!(validate_service(invalid).is_err(), "accepted {invalid:?}");
        }
        assert_eq!(validate_service("nginx.service").unwrap(), "nginx.service");
    }

    #[test]
    fn timestamps_use_iso_utc_and_expiry_is_monotonic() {
        let now = epoch_seconds();
        assert!(iso8601(now).ends_with('Z'));
        assert!(iso8601(now + 60) > iso8601(now));
    }

    fn sample_plan_and_grant() -> (PlanRecord, GrantRecord) {
        let binding = SessionSecurityBinding {
            summary: SessionSummary {
                session_id: "session-a".to_owned(),
                profile_id: "profile-a".to_owned(),
                host: "127.0.0.1".to_owned(),
                port: 2222,
                username: "tester".to_owned(),
                state: SshState::Connected,
            },
            identity: HostKeyIdentity {
                key_type: "ssh-ed25519".to_owned(),
                fingerprint_sha256: "SHA256:test-fingerprint".to_owned(),
                public_key: "ssh-ed25519 AAAATEST".to_owned(),
            },
        };
        let action = DiagnosticAction::ServiceInspect {
            service: "nginx.service".to_owned(),
        };
        let step = StepRecord {
            preview: action.preview("step-a".to_owned(), true),
            action,
        };
        let expires_epoch = epoch_seconds() + 120;
        let mut preview = super::DiagnosticPlanPreview {
            plan_id: "plan-a".to_owned(),
            revision: 1,
            plan_hash: String::new(),
            session_id: binding.summary.session_id.clone(),
            host: binding.summary.host.clone(),
            port: binding.summary.port,
            username: binding.summary.username.clone(),
            fingerprint_sha256: binding.identity.fingerprint_sha256.clone(),
            template_id: DiagnosticTemplateId::ServiceFailed,
            why: "检查 systemd 服务".to_owned(),
            created_at: iso8601(epoch_seconds()),
            expires_at: iso8601(expires_epoch),
            steps: vec![step.preview.clone()],
            context_summary: None,
        };
        let steps = vec![step];
        preview.plan_hash = hash_plan(&preview, &binding, &steps).unwrap();
        let plan = PlanRecord {
            preview: preview.clone(),
            binding: binding.clone(),
            steps,
            expires_epoch,
        };
        let grant = GrantRecord {
            plan_id: preview.plan_id,
            revision: preview.revision,
            plan_hash: preview.plan_hash,
            session_id: binding.summary.session_id,
            profile_id: binding.summary.profile_id,
            host_key_identity: binding.identity,
            policy_version: POLICY_VERSION,
            allowed_step_ids: vec!["step-a".to_owned()],
            expires_epoch,
        };
        (plan, grant)
    }

    #[test]
    fn approval_grant_is_bound_to_plan_session_identity_policy_and_expiry() {
        let (plan, grant) = sample_plan_and_grant();
        assert!(grant_matches_plan(&grant, &plan, epoch_seconds()));

        let mut changed = grant.clone();
        changed.session_id = "session-b".to_owned();
        assert!(!grant_matches_plan(&changed, &plan, epoch_seconds()));
        let mut changed = grant.clone();
        changed.host_key_identity.public_key.push_str("changed");
        assert!(!grant_matches_plan(&changed, &plan, epoch_seconds()));
        let mut changed = grant.clone();
        changed.policy_version += 1;
        assert!(!grant_matches_plan(&changed, &plan, epoch_seconds()));
        let mut changed = grant.clone();
        changed.expires_epoch = epoch_seconds();
        assert!(!grant_matches_plan(&changed, &plan, epoch_seconds()));
        let mut changed_plan = plan.clone();
        changed_plan.preview.revision += 1;
        assert!(!grant_matches_plan(&grant, &changed_plan, epoch_seconds()));
        let mut changed_plan = plan.clone();
        changed_plan.preview.plan_hash.push_str("tampered");
        assert!(!grant_matches_plan(&grant, &changed_plan, epoch_seconds()));
        let mut changed_plan = plan.clone();
        changed_plan.steps[0].preview.enabled = false;
        assert!(!grant_matches_plan(&grant, &changed_plan, epoch_seconds()));
    }

    #[test]
    fn canonical_hash_changes_when_a_read_scope_or_host_key_changes() {
        let (plan, _) = sample_plan_and_grant();
        let original = hash_plan(&plan.preview, &plan.binding, &plan.steps).unwrap();
        let mut changed_plan = plan.clone();
        changed_plan.steps[0].action = DiagnosticAction::ServiceInspect {
            service: "sshd.service".to_owned(),
        };
        changed_plan.steps[0].preview = changed_plan.steps[0]
            .action
            .preview("step-a".to_owned(), true);
        assert_ne!(
            original,
            hash_plan(
                &changed_plan.preview,
                &changed_plan.binding,
                &changed_plan.steps
            )
            .unwrap()
        );
        let mut changed_binding = plan.binding.clone();
        changed_binding.identity.public_key.push_str("new-key");
        assert_ne!(
            original,
            hash_plan(&plan.preview, &changed_binding, &plan.steps).unwrap()
        );
    }
}
