// OWNER: media and calls client builder. Extension points the conversation UI uses.
import type { Attachment, Message } from '../../api/types';

export interface UploadItem {
  localId: string;
  fileName: string;
  progress: number;
  status: 'preparing' | 'uploading' | 'finalizing' | 'ready' | 'failed';
  attachmentId: string | null;
  error: string | null;
  previewUrl: string | null;
}

// The composer renders <AttachmentButton/> and <PendingUploads/>; it reads ready
// attachment ids from useUploads(key).readyIds when sending and calls clear().
export function useUploads(_key: string) {
  return { items: [] as UploadItem[], readyIds: [] as string[], busy: false, add: (_files: File[]) => undefined, remove: (_localId: string) => undefined, retry: (_localId: string) => undefined, clear: () => undefined };
}
export function AttachmentButton(_props: { uploadKey: string; channelId: string; disabled?: boolean }) {
  return null;
}
export function PendingUploads(_props: { uploadKey: string }) {
  return null;
}
// Message rows render this under the text.
export function MessageAttachments(_props: { message: Message; attachments: Attachment[] }) {
  return null;
}
