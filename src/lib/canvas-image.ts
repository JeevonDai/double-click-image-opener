import type { App } from 'obsidian';
import { TFile } from 'obsidian';

interface CanvasNodeData {
  file?: string;
}

interface CanvasNode {
  file?: TFile;
  getData?: () => CanvasNodeData;
}

interface Canvas {
  nodes?: Map<string, CanvasNode>;
  selection?: Set<CanvasNode>;
}

interface CanvasView {
  canvas?: Canvas;
}

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
]);

function getNodeFile(app: App, node: CanvasNode | undefined): TFile | null {
  if (!node) {
    return null;
  }

  if (node.file instanceof TFile) {
    return IMAGE_EXTENSIONS.has(node.file.extension.toLowerCase())
      ? node.file
      : null;
  }

  const filePath = node.getData?.().file;
  if (!filePath) {
    return null;
  }

  const sourcePath = app.workspace.getActiveFile()?.path ?? '';
  const file = app.metadataCache.getFirstLinkpathDest(filePath, sourcePath);
  return file instanceof TFile &&
    IMAGE_EXTENSIONS.has(file.extension.toLowerCase())
    ? file
    : null;
}

/**
 * Resolves the selected or most recently clicked Canvas image node.
 * Canvas internals are not part of Obsidian's public typings, so access is
 * deliberately isolated in this compatibility helper.
 */
export function getFocusedCanvasImageFile(
  app: App,
  lastClickedNodeId: string | null,
): TFile | null {
  const view = app.workspace.getMostRecentLeaf()?.view as
    | CanvasView
    | undefined;
  const canvas = view?.canvas;
  if (!canvas) {
    return null;
  }

  if (lastClickedNodeId) {
    const clickedFile = getNodeFile(app, canvas.nodes?.get(lastClickedNodeId));
    if (clickedFile) {
      return clickedFile;
    }
  }

  if (canvas.selection?.size === 1) {
    return getNodeFile(app, canvas.selection.values().next().value);
  }

  return null;
}
