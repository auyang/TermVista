use std::{
    env,
    fs::File,
    io::{Read, Result as IoResult},
    path::Path,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let config_path = args.next().ok_or("缺少 Tauri 配置文件路径")?;
    let artifact_path = args.next().ok_or("缺少更新包路径")?;
    let signature_path = args.next().ok_or("缺少签名文件路径")?;
    let expected_version = args.next().ok_or("缺少预期版本号")?;
    if args.next().is_some() {
        return Err("参数过多".into());
    }

    let config: Value = serde_json::from_slice(&std::fs::read(config_path)?)?;
    let pubkey_b64 = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Tauri updater 公钥未配置")?;
    let pubkey_text = String::from_utf8(STANDARD.decode(pubkey_b64)?)?;
    let public_key = PublicKey::decode(&pubkey_text)?;

    let signature_b64 = std::fs::read_to_string(signature_path)?;
    let signature_text = String::from_utf8(STANDARD.decode(signature_b64.trim())?)?;
    let signature = Signature::decode(&signature_text)?;
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or("更新包签名没有绑定版本号")?;
    if signed_version != expected_version {
        return Err(
            format!("签名版本 {signed_version} 与预期版本 {expected_version} 不一致").into(),
        );
    }

    verify_artifact_streaming(&public_key, &signature, Path::new(&artifact_path))?;
    println!("更新包签名及版本校验通过：{expected_version}");
    Ok(())
}

fn verify_artifact_streaming(
    public_key: &PublicKey,
    signature: &Signature,
    artifact_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut file = File::open(artifact_path)?;
    let mut verifier = public_key.verify_stream(signature)?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = read_chunk(&mut file, &mut buffer)?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier.finalize()?;
    Ok(())
}

fn read_chunk(file: &mut File, buffer: &mut [u8]) -> IoResult<usize> {
    file.read(buffer)
}
