import test from "node:test";
import assert from "node:assert/strict";
import { matchDiagnosticIntent } from "../src/features/diagnostics/diagnosticIntent.ts";

test("自然语言诊断只匹配唯一的已有只读模板", () => {
  assert.equal(matchDiagnosticIntent("为什么 Nginx 返回 502？"), "nginx502");
  assert.equal(matchDiagnosticIntent("磁盘空间快满了"), "diskLow");
  assert.equal(matchDiagnosticIntent("8080 端口没有监听"), "portUnbound");
  assert.equal(matchDiagnosticIntent("systemd 服务启动失败"), "serviceFailed");
});

test("空、模糊或不支持的诊断描述不会猜测模板", () => {
  assert.equal(matchDiagnosticIntent("  "), null);
  assert.equal(matchDiagnosticIntent("服务器有问题"), null);
  assert.equal(matchDiagnosticIntent("Nginx 502 同时磁盘空间已满"), null);
});
