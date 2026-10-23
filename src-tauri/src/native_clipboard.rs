#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn read_file_paths() -> Result<Vec<String>, String> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSArray, NSString, NSURL};

    unsafe {
        let pasteboard = NSPasteboard::generalPasteboard();
        let mut result = Vec::new();
        if let Some(items) = pasteboard.pasteboardItems() {
            for item in &*items {
                if let Some(url) = item.stringForType(NSPasteboardTypeFileURL) {
                    if let Some(path) = NSURL::URLWithString(&url).and_then(|url| url.path()) {
                        result.push(path.to_string());
                    }
                }
            }
        }

        if result.is_empty() {
            let file_types = NSArray::arrayWithObject(NSFilenamesPboardType);
            if pasteboard.availableTypeFromArray(&file_types).is_some() {
                if let Some(value) = pasteboard.propertyListForType(NSFilenamesPboardType) {
                    let paths = value
                        .downcast::<NSArray<AnyObject>>()
                        .map_err(|_| "无法识别剪贴板中的本地文件列表。".to_owned())?;
                    for item in &*paths {
                        let path = item
                            .downcast::<NSString>()
                            .map_err(|_| "剪贴板中的文件路径格式无效。".to_owned())?;
                        let path = path.to_string();
                        if !path.is_empty() {
                            result.push(path);
                        }
                    }
                }
            }
        }
        if result.len() > 100 {
            return Err("一次最多粘贴 100 个本地文件。".to_owned());
        }
        Ok(result)
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read_file_paths() -> Result<Vec<String>, String> {
    Err("系统剪贴板文件粘贴暂只支持 macOS；也可拖拽文件或使用上传按钮。".to_owned())
}
