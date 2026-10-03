// OWNER: media and calls client builder. Extension points the conversation UI uses.
//
// The composer renders <AttachmentButton/> and <PendingUploads/>; it reads ready
// attachment ids from useUploads(key).readyIds when sending and calls clear().
// useUploads(key).add(files) also takes files from paste or drop. The key is the
// composer's draft key ("<channel>" or "<channel>:<thread root>"). Message rows
// render <MessageAttachments/> under the text.
export type { UploadItem, UploadStatus } from './uploads';
export { useUploads } from './hooks';
export type { UploadsApi } from './hooks';
export { AttachmentButton, PendingUploads } from './Composer';
export { MessageAttachments } from './Attachments';
