declare module "docx-preview" {
  export function renderAsync(
    blob: Blob,
    container: HTMLElement,
    options?: {
      className?: string;
      inWrapper?: boolean;
    }
  ): Promise<void>;
}