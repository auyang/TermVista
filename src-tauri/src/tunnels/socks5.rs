use std::net::{Ipv4Addr, Ipv6Addr};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const SOCKS_VERSION: u8 = 0x05;
const METHOD_NO_AUTH: u8 = 0x00;
const METHOD_REJECT: u8 = 0xff;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

pub(super) const REP_SUCCEEDED: u8 = 0x00;
pub(super) const REP_GENERAL_FAILURE: u8 = 0x01;
pub(super) const REP_NETWORK_UNREACHABLE: u8 = 0x03;
pub(super) const REP_HOST_UNREACHABLE: u8 = 0x04;
pub(super) const REP_CONNECTION_REFUSED: u8 = 0x05;
pub(super) const REP_COMMAND_NOT_SUPPORTED: u8 = 0x07;
pub(super) const REP_ADDRESS_TYPE_NOT_SUPPORTED: u8 = 0x08;
const MAX_DOMAIN_BYTES: usize = 253;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Socks5Target {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RequestError {
    NoAcceptableMethods,
    Reply(u8),
}

pub(super) async fn read_connect_request<S>(stream: &mut S) -> Result<Socks5Target, RequestError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut greeting = [0; 2];
    read_exact(stream, &mut greeting).await?;
    if greeting[0] != SOCKS_VERSION || greeting[1] == 0 {
        return Err(RequestError::Reply(REP_GENERAL_FAILURE));
    }
    let mut methods = [0; u8::MAX as usize];
    let method_count = usize::from(greeting[1]);
    read_exact(stream, &mut methods[..method_count]).await?;
    if methods[..method_count].contains(&METHOD_NO_AUTH) {
        stream
            .write_all(&[SOCKS_VERSION, METHOD_NO_AUTH])
            .await
            .map_err(|_| RequestError::Reply(REP_GENERAL_FAILURE))?;
    } else {
        let _ = stream.write_all(&[SOCKS_VERSION, METHOD_REJECT]).await;
        return Err(RequestError::NoAcceptableMethods);
    }

    let mut header = [0; 4];
    read_exact(stream, &mut header).await?;
    if header[0] != SOCKS_VERSION || header[2] != 0 {
        return Err(RequestError::Reply(REP_GENERAL_FAILURE));
    }
    if header[1] != CMD_CONNECT {
        return Err(RequestError::Reply(REP_COMMAND_NOT_SUPPORTED));
    }

    let host = match header[3] {
        ATYP_IPV4 => {
            let mut address = [0; 4];
            read_exact(stream, &mut address).await?;
            Ipv4Addr::from(address).to_string()
        }
        ATYP_IPV6 => {
            let mut address = [0; 16];
            read_exact(stream, &mut address).await?;
            Ipv6Addr::from(address).to_string()
        }
        ATYP_DOMAIN => {
            let mut length = [0; 1];
            read_exact(stream, &mut length).await?;
            let length = usize::from(length[0]);
            if length == 0 || length > MAX_DOMAIN_BYTES {
                return Err(RequestError::Reply(REP_ADDRESS_TYPE_NOT_SUPPORTED));
            }
            let mut domain = [0; MAX_DOMAIN_BYTES];
            read_exact(stream, &mut domain[..length]).await?;
            normalize_domain(&domain[..length])
                .ok_or(RequestError::Reply(REP_ADDRESS_TYPE_NOT_SUPPORTED))?
        }
        _ => return Err(RequestError::Reply(REP_ADDRESS_TYPE_NOT_SUPPORTED)),
    };

    let mut port = [0; 2];
    read_exact(stream, &mut port).await?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        return Err(RequestError::Reply(REP_GENERAL_FAILURE));
    }

    Ok(Socks5Target { host, port })
}

pub(super) async fn write_reply<S>(stream: &mut S, reply: u8) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    stream
        .write_all(&[SOCKS_VERSION, reply, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
        .await
}

async fn read_exact<S>(stream: &mut S, buffer: &mut [u8]) -> Result<(), RequestError>
where
    S: AsyncRead + Unpin,
{
    stream
        .read_exact(buffer)
        .await
        .map(|_| ())
        .map_err(|_| RequestError::Reply(REP_GENERAL_FAILURE))
}

fn normalize_domain(bytes: &[u8]) -> Option<String> {
    let domain = std::str::from_utf8(bytes).ok()?.trim_end_matches('.');
    if domain.is_empty() || domain.chars().any(char::is_control) {
        return None;
    }
    let ascii = idna::domain_to_ascii(domain).ok()?;
    if ascii.is_empty()
        || ascii.len() > 253
        || ascii.split('.').any(|label| {
            label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
        })
    {
        return None;
    }
    Some(ascii.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::{
        REP_ADDRESS_TYPE_NOT_SUPPORTED, REP_COMMAND_NOT_SUPPORTED, RequestError, Socks5Target,
        normalize_domain, read_connect_request,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};

    #[test]
    fn domain_names_are_bounded_and_normalized_for_remote_resolution() {
        assert_eq!(
            normalize_domain("ExAmPlE.com".as_bytes()),
            Some("example.com".to_owned())
        );
        assert_eq!(
            normalize_domain("例え.テスト".as_bytes()),
            Some("xn--r8jz45g.xn--zckzah".to_owned())
        );
        assert!(normalize_domain(&[0xff]).is_none());
        assert!(normalize_domain(b"a..example.com").is_none());
        assert!(normalize_domain(b"example.com\0").is_none());
    }

    async fn parse_request(request: Vec<u8>) -> Result<Socks5Target, RequestError> {
        let (mut client, mut server_stream) = duplex(1024);
        let server = tokio::spawn(async move { read_connect_request(&mut server_stream).await });
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut method = [0; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [5, 0]);
        client.write_all(&request).await.unwrap();
        server.await.unwrap()
    }

    #[tokio::test]
    async fn accepts_ipv4_ipv6_and_domain_connect_targets() {
        assert_eq!(
            parse_request(vec![5, 1, 0, 1, 192, 0, 2, 9, 1, 187]).await,
            Ok(Socks5Target {
                host: "192.0.2.9".to_owned(),
                port: 443,
            })
        );

        let ipv6 = "2001:db8::1"
            .parse::<std::net::Ipv6Addr>()
            .unwrap()
            .octets();
        let mut request = vec![5, 1, 0, 4];
        request.extend_from_slice(&ipv6);
        request.extend_from_slice(&443_u16.to_be_bytes());
        assert_eq!(
            parse_request(request).await,
            Ok(Socks5Target {
                host: "2001:db8::1".to_owned(),
                port: 443,
            })
        );

        let domain = b"ExAmPlE.com";
        let mut request = vec![5, 1, 0, 3, domain.len() as u8];
        request.extend_from_slice(domain);
        request.extend_from_slice(&443_u16.to_be_bytes());
        assert_eq!(
            parse_request(request).await,
            Ok(Socks5Target {
                host: "example.com".to_owned(),
                port: 443,
            })
        );
    }

    #[tokio::test]
    async fn rejects_unsupported_commands_and_oversized_domain_names() {
        assert_eq!(
            parse_request(vec![5, 3, 0, 1, 127, 0, 0, 1, 0, 53]).await,
            Err(RequestError::Reply(REP_COMMAND_NOT_SUPPORTED))
        );
        assert_eq!(
            parse_request(vec![5, 1, 0, 3, 254]).await,
            Err(RequestError::Reply(REP_ADDRESS_TYPE_NOT_SUPPORTED))
        );
    }
}
