// Which message is being edited in place (one at a time across the app).
import { create } from 'zustand';

export const useEditing = create<{ id: string | null }>()(() => ({ id: null }));

export function startEditing(id: string): void {
  useEditing.setState({ id });
}

export function stopEditing(): void {
  useEditing.setState({ id: null });
}
