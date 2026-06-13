declare module "electron" {
  export const shell: {
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
  };

  export const remote: {
    dialog?: {
      showSaveDialog(options: {
        title?: string;
        defaultPath?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
      }): Promise<{ canceled: boolean; filePath?: string }>;
    };
  } | undefined;
}