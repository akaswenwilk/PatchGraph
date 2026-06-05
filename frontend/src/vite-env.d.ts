/// <reference types="vite/client" />

declare global {
  interface DirectoryPickerOptions {
    mode?: 'read' | 'readwrite'
  }

  interface Window {
    showDirectoryPicker(
      options?: DirectoryPickerOptions,
    ): Promise<FileSystemDirectoryHandle>
  }
}

export {}
