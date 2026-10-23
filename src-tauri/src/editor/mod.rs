mod codec;
mod service;

pub use service::{
    EditorCompareResult, EditorError, EditorErrorCode, RemoteDocument, RemoteEditorService,
    RemoteSaveResult, SaveCapabilities, SaveStatus,
};
