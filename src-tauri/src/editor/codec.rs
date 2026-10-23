use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum TextEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedText {
    pub text: String,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodecError {
    Binary,
    UnknownEncoding,
    InvalidUtf16,
    MixedLineEndings,
}

pub fn decode(bytes: &[u8]) -> Result<DecodedText, CodecError> {
    let (content, encoding) = if let Some(content) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        (content, TextEncoding::Utf8Bom)
    } else if let Some(content) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        (content, TextEncoding::Utf16Le)
    } else if let Some(content) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        (content, TextEncoding::Utf16Be)
    } else {
        (bytes, TextEncoding::Utf8)
    };

    let decoded = match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            if content.contains(&0) {
                return Err(CodecError::Binary);
            }
            std::str::from_utf8(content)
                .map_err(|_| CodecError::UnknownEncoding)?
                .to_owned()
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            if content.len() % 2 != 0 {
                return Err(CodecError::InvalidUtf16);
            }
            let words = content.chunks_exact(2).map(|pair| match encoding {
                TextEncoding::Utf16Le => u16::from_le_bytes([pair[0], pair[1]]),
                _ => u16::from_be_bytes([pair[0], pair[1]]),
            });
            char::decode_utf16(words)
                .collect::<Result<String, _>>()
                .map_err(|_| CodecError::InvalidUtf16)?
        }
        TextEncoding::Unknown => return Err(CodecError::UnknownEncoding),
    };

    if decoded.chars().any(|character| {
        matches!(character, '\u{0000}'..='\u{0008}' | '\u{000B}'..='\u{000C}' | '\u{000E}'..='\u{001F}')
    }) {
        return Err(CodecError::Binary);
    }

    let line_ending = detect_line_ending(&decoded);
    let text = decoded.replace("\r\n", "\n").replace('\r', "\n");
    Ok(DecodedText {
        text,
        encoding,
        line_ending,
    })
}

pub fn encode(
    text: &str,
    encoding: TextEncoding,
    line_ending: LineEnding,
) -> Result<Vec<u8>, CodecError> {
    if line_ending == LineEnding::Mixed {
        return Err(CodecError::MixedLineEndings);
    }
    let line_break = match line_ending {
        LineEnding::Lf => "\n",
        LineEnding::Crlf => "\r\n",
        LineEnding::Cr => "\r",
        LineEnding::Mixed => return Err(CodecError::MixedLineEndings),
    };
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let encoded_text = normalized.replace('\n', line_break);

    match encoding {
        TextEncoding::Utf8 => Ok(encoded_text.into_bytes()),
        TextEncoding::Utf8Bom => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(encoded_text.as_bytes());
            Ok(bytes)
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            let mut bytes = match encoding {
                TextEncoding::Utf16Le => vec![0xFF, 0xFE],
                _ => vec![0xFE, 0xFF],
            };
            for word in encoded_text.encode_utf16() {
                bytes.extend_from_slice(&match encoding {
                    TextEncoding::Utf16Le => word.to_le_bytes(),
                    _ => word.to_be_bytes(),
                });
            }
            Ok(bytes)
        }
        TextEncoding::Unknown => Err(CodecError::UnknownEncoding),
    }
}

fn detect_line_ending(text: &str) -> LineEnding {
    let mut lf = 0;
    let mut crlf = 0;
    let mut cr = 0;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' if chars.peek() == Some(&'\n') => {
                let _ = chars.next();
                crlf += 1;
            }
            '\r' => cr += 1,
            '\n' => lf += 1,
            _ => {}
        }
    }
    let styles = usize::from(lf > 0) + usize::from(crlf > 0) + usize::from(cr > 0);
    if styles > 1 {
        LineEnding::Mixed
    } else if crlf > 0 {
        LineEnding::Crlf
    } else if cr > 0 {
        LineEnding::Cr
    } else {
        LineEnding::Lf
    }
}

#[cfg(test)]
mod tests {
    use super::{CodecError, LineEnding, TextEncoding, decode, encode};

    #[test]
    fn utf8_bom_and_line_endings_round_trip_without_normalization_loss() {
        for (encoding, eol, bytes) in [
            (
                TextEncoding::Utf8,
                LineEnding::Lf,
                b"alpha\nbeta\n".to_vec(),
            ),
            (
                TextEncoding::Utf8Bom,
                LineEnding::Crlf,
                b"\xEF\xBB\xBFalpha\r\nbeta\r\n".to_vec(),
            ),
            (
                TextEncoding::Utf8,
                LineEnding::Cr,
                b"alpha\rbeta\r".to_vec(),
            ),
        ] {
            let decoded = decode(&bytes).unwrap();
            assert_eq!(decoded.encoding, encoding);
            assert_eq!(decoded.line_ending, eol);
            assert_eq!(encode(&decoded.text, encoding, eol).unwrap(), bytes);
        }
    }

    #[test]
    fn utf16_bom_endianness_round_trips_non_ascii_text() {
        for encoding in [TextEncoding::Utf16Le, TextEncoding::Utf16Be] {
            let original = encode("端境\n编辑", encoding, LineEnding::Lf).unwrap();
            let decoded = decode(&original).unwrap();
            assert_eq!(decoded.text, "端境\n编辑");
            assert_eq!(decoded.encoding, encoding);
            assert_eq!(
                encode(&decoded.text, encoding, decoded.line_ending).unwrap(),
                original
            );
        }
    }

    #[test]
    fn binary_invalid_and_mixed_line_endings_are_not_silently_rewritten() {
        assert_eq!(decode(b"a\0b"), Err(CodecError::Binary));
        assert_eq!(decode(&[0xFF, 0xFE, 0x00]), Err(CodecError::InvalidUtf16));
        assert_eq!(
            decode(&[0xFF, 0xFE, 0x00, 0xD8]),
            Err(CodecError::InvalidUtf16)
        );
        assert_eq!(decode(b"\xFF"), Err(CodecError::UnknownEncoding));
        let mixed = decode(b"a\r\nb\nc").unwrap();
        assert_eq!(mixed.line_ending, LineEnding::Mixed);
        assert_eq!(
            encode(&mixed.text, TextEncoding::Utf8, mixed.line_ending),
            Err(CodecError::MixedLineEndings)
        );
    }
}
