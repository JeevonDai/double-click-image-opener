import type { App, KeymapEventHandler, TAbstractFile } from 'obsidian';
import { normalizePath, TFile } from 'obsidian';
import type DoubleClickImageOpenerPlugin from '../main';
import { getFocusedCanvasImageFile } from './canvas-image';
import * as ErrorHandler from './error-handler';
import { PathResolver } from './path-resolver';
import { openWithDefaultApp } from './system-launcher';

interface FileManagerWithRenamePrompt {
  promptForFileRename(file: TAbstractFile): Promise<void>;
}

interface VaultAdapterWithPath {
  basePath?: string;
}

/**
 * Handles image-related DOM events and coordinates image opening functionality
 */
export class ImageEventHandler {
  private pathResolver: PathResolver;
  private boundHandleDoubleClick: (event: MouseEvent) => void;
  private boundHandleClick: (event: MouseEvent) => void;
  private f2KeymapHandler: KeymapEventHandler | null = null;
  private lastClickedImageEmbed: HTMLElement | null = null;
  private lastClickedCanvasNodeId: string | null = null;

  /**
   * Creates a new ImageEventHandler instance
   * @param app - The Obsidian App instance
   * @param plugin - The plugin instance
   */
  constructor(
    app: App,
    private plugin: DoubleClickImageOpenerPlugin,
  ) {
    this.pathResolver = new PathResolver(app);
    // Bind the event handler to maintain proper 'this' context
    this.boundHandleDoubleClick = (event: MouseEvent) => {
      void this.handleImageDoubleClick(event);
    };
    this.boundHandleClick = (event: MouseEvent) => {
      this.handleImageClick(event);
    };
  }

  /**
   * Returns the image file currently focused by click or embed selection
   */
  public getFocusedImageFile(): TFile | null {
    const canvasFile = getFocusedCanvasImageFile(
      this.plugin.app,
      this.lastClickedCanvasNodeId,
    );
    if (canvasFile) {
      return canvasFile;
    }

    const embed = this.findFocusedImageEmbed();
    if (!embed) {
      return null;
    }

    return this.resolveImageFile(embed);
  }

  /**
   * Opens Obsidian's built-in rename dialog for the focused image file
   */
  public renameFocusedImage(): void {
    const file = this.getFocusedImageFile();
    if (!file) {
      return;
    }

    void (
      this.plugin.app.fileManager as unknown as FileManagerWithRenamePrompt
    ).promptForFileRename(file);
  }

  private findFocusedImageEmbed(): HTMLElement | null {
    const selectedEmbed = document.querySelector(
      '.internal-embed.image-embed.is-selected, .internal-embed.image-embed.mod-selected',
    );
    if (selectedEmbed instanceof HTMLElement) {
      return selectedEmbed;
    }

    if (this.lastClickedImageEmbed?.isConnected) {
      return this.lastClickedImageEmbed;
    }

    return null;
  }

  private resolveImageFile(embed: HTMLElement): TFile | null {
    const sourcePath = this.plugin.app.workspace.getActiveFile()?.path ?? '';
    const rawPath = embed.getAttribute('src') || embed.getAttribute('alt');

    if (rawPath) {
      try {
        const file = this.plugin.app.metadataCache.getFirstLinkpathDest(
          decodeURIComponent(rawPath),
          sourcePath,
        );
        if (file instanceof TFile) {
          return file;
        }
      } catch {
        // Fall through to URL-based resolution
      }
    }

    const img = embed.querySelector('img');
    if (img?.src) {
      return this.getFileFromImageUrl(img.src);
    }

    return null;
  }

  private getFileFromImageUrl(src: string): TFile | null {
    try {
      const url = new URL(src);
      if (url.protocol !== 'app:') {
        return null;
      }

      const adapter = this.plugin.app.vault.adapter as VaultAdapterWithPath;
      const adapterBasePath = adapter.basePath;
      if (!adapterBasePath) {
        return null;
      }

      const basePath = normalizePath(adapterBasePath).replace('file://', '');
      const urlPath = decodeURI(url.pathname.replace('/_capacitor_file_', ''))
        .split('/')
        .filter((part) => part !== '')
        .join('/');

      if (!urlPath.startsWith(basePath)) {
        return null;
      }

      const relativePath = urlPath.slice(basePath.length + 1);
      return this.plugin.app.vault.getFileByPath(relativePath);
    } catch {
      return null;
    }
  }

  private handleImageClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const canvasNode = target.closest('.canvas-node');

    if (canvasNode instanceof HTMLElement) {
      const nodeId = canvasNode.dataset.id;
      if (nodeId) {
        this.lastClickedCanvasNodeId = nodeId;
        this.lastClickedImageEmbed = null;
        return;
      }
    }

    const embed = target.closest('.internal-embed.image-embed');

    if (embed instanceof HTMLElement) {
      this.lastClickedImageEmbed = embed;
      this.lastClickedCanvasNodeId = null;
      return;
    }

    if (
      !target.closest('.canvas-node') &&
      !target.closest('.internal-embed.image-embed')
    ) {
      this.lastClickedCanvasNodeId = null;
      this.lastClickedImageEmbed = null;
    }
  }

  private handleF2Key(event: KeyboardEvent): boolean {
    if (!this.getFocusedImageFile()) {
      return false;
    }

    event.preventDefault();
    this.renameFocusedImage();
    return true;
  }

  /**
   * Checks if the given element is an image element
   * @param element - The HTML element to check
   * @returns true if the element is an image element
   */
  public isImageElement(element: HTMLElement): boolean {
    // Check if it's directly an img element
    if (element.tagName.toLowerCase() === 'img') {
      return true;
    }

    // Check if it's a span with an image background (Obsidian's image rendering)
    if (
      element.tagName.toLowerCase() === 'span' &&
      element.classList.contains('image-embed')
    ) {
      return true;
    }

    // Check if it contains an img element as a child.
    // To avoid false positives when clicking on large containers (e.g., Canvas view)
    // that contain multiple unrelated image nodes, only treat the element as an
    // image element if it contains exactly one <img>. An element with many images
    // is a container, not an image-specific element, and the default Obsidian
    // behavior (e.g., creating a Canvas note) should be preserved.
    const allImgs = element.querySelectorAll('img');
    return allImgs.length === 1;
  }

  /**
   * Extracts the image path from an image element
   * @param element - The image element to extract path from
   * @returns The image path or null if not found
   */
  public extractImagePath(element: HTMLImageElement): string | null {
    // Try multiple sources for the image path
    const possiblePaths = [
      element.src,
      element.alt,
      element.dataset.src,
      element.getAttribute('data-path'),
      element.getAttribute('data-href'),
      element.title,
    ].filter(Boolean);

    for (const path of possiblePaths) {
      if (path) {
        const sanitizedPath = this.sanitizeImagePath(path);
        if (sanitizedPath) {
          return sanitizedPath;
        }
      }
    }

    return null;
  }

  /**
   * Validates if the given path represents a supported image format
   * @param imagePath - The image path to validate
   * @returns True if the format is supported, false otherwise
   */
  private isValidImageFormat(imagePath: string): boolean {
    if (!imagePath || typeof imagePath !== 'string') {
      return false;
    }

    const supportedExtensions = [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
      '.bmp',
      '.svg',
      '.ico',
      '.tiff',
      '.tif',
      '.avif',
      '.heic',
      '.heif',
    ];

    // Handle paths with query parameters or fragments
    const cleanPath = imagePath.split('?')[0].split('#')[0];
    const lowercasePath = cleanPath.toLowerCase().trim();

    // Check if path has any extension
    if (!lowercasePath.includes('.')) {
      return false;
    }

    // Enhanced validation: check for multiple extensions (e.g., .tar.gz)
    // Only consider the last extension for image format validation
    const lastDotIndex = lowercasePath.lastIndexOf('.');
    if (lastDotIndex === -1 || lastDotIndex === lowercasePath.length - 1) {
      return false;
    }

    const extension = lowercasePath.substring(lastDotIndex);

    // Additional validation: ensure extension is reasonable length
    if (extension.length > 10) {
      return false;
    }

    return supportedExtensions.includes(extension);
  }

  /**
   * Sanitizes and normalizes an image path to handle special characters
   * @param imagePath - The raw image path
   * @returns Sanitized image path or null if invalid
   */
  private sanitizeImagePath(imagePath: string): string | null {
    if (!imagePath || typeof imagePath !== 'string') {
      return null;
    }

    try {
      // Remove any URL protocols and decode URI components
      let path = imagePath.trim();

      // Handle file:// URLs by extracting the path
      if (path.startsWith('file://')) {
        try {
          path = decodeURIComponent(path.replace('file://', ''));
        } catch {
          // Handle malformed URI encoding
          path = path.replace('file://', '');
        }
      }

      // Handle app:// URLs (Obsidian's internal protocol)
      if (path.startsWith('app://')) {
        const match = path.match(/app:\/\/[^/]+\/(.+)/);
        if (match) {
          try {
            path = decodeURIComponent(match[1]);
          } catch {
            // Handle malformed URI encoding
            path = match[1];
          }
        }
      }

      // Handle data URLs (base64 encoded images) - not supported for opening
      if (path.startsWith('data:')) {
        ErrorHandler.handleEmbeddedImageError(path);
        return null;
      }

      // Handle blob URLs - not supported for opening
      if (path.startsWith('blob:')) {
        ErrorHandler.handleEmbeddedImageError(path);
        return null;
      }

      // Handle http/https URLs - not supported for opening local files
      if (path.startsWith('http://') || path.startsWith('https://')) {
        ErrorHandler.handleNetworkImageError(path);
        return null;
      }

      // Remove query parameters and fragments
      path = path.split('?')[0].split('#')[0];

      // Enhanced handling of special characters and Unicode
      // Normalize Unicode characters (NFD to NFC)
      if (typeof path.normalize === 'function') {
        path = path.normalize('NFC');
      }

      // Normalize path separators and handle special characters
      path = path.replace(/\\/g, '/');

      // Handle encoded characters that might be in the path
      try {
        // Only decode if it looks like it contains encoded characters
        if (path.includes('%')) {
          const decodedPath = decodeURIComponent(path);
          // Verify the decoded path doesn't contain dangerous characters
          if (!this.isDangerousPath(decodedPath)) {
            path = decodedPath;
          }
        }
      } catch {
        // If decoding fails, continue with the original path
        // This handles cases where % is used literally in filenames
      }

      // Remove any leading/trailing whitespace
      path = path.trim();

      // Additional validation for edge cases
      if (path.length === 0) {
        return null;
      }

      // Check for paths that are just dots or slashes
      if (/^[./\\]+$/.test(path)) {
        return null;
      }

      return path;
    } catch (error) {
      ErrorHandler.handleGenericError(
        error instanceof Error ? error : new Error(String(error)),
        'image path sanitization',
      );
      return null;
    }
  }

  /**
   * Handles double-click events on image elements
   * @param event - The mouse event
   */
  private async handleImageDoubleClick(event: MouseEvent): Promise<void> {
    try {
      const target = event.target as HTMLElement;

      // Check if the clicked element is an image or contains an image
      if (!this.isImageElement(target)) {
        return;
      }

      // Prevent default behavior and stop event propagation to avoid interference
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Get the actual image element
      let imgElement: HTMLImageElement | null = null;

      if (target.tagName.toLowerCase() === 'img') {
        imgElement = target as HTMLImageElement;
      } else {
        // Look for img element within the target
        imgElement = target.querySelector('img');
      }

      if (!imgElement) {
        ErrorHandler.handleGenericError(
          new Error('Could not find image element'),
          'image element detection',
        );
        return;
      }

      // Extract the image path
      const imagePath = this.extractImagePath(imgElement);
      if (!imagePath) {
        ErrorHandler.handleGenericError(
          new Error('Could not extract image path from element'),
          'image path extraction',
        );
        return;
      }

      // Validate image format (comprehensive check)
      if (!this.isValidImageFormat(imagePath)) {
        ErrorHandler.handleInvalidImageFormat(imagePath);
        return;
      }

      // Additional validation for edge cases
      if (imagePath.length > 1000) {
        ErrorHandler.handleGenericError(
          new Error('Image path is too long'),
          'image path validation',
        );
        return;
      }

      // Check for potentially dangerous paths
      if (this.isDangerousPath(imagePath)) {
        ErrorHandler.handleGenericError(
          new Error('Image path contains potentially dangerous characters'),
          'image path security validation',
        );
        return;
      }

      // Resolve the image path to an absolute path using PathResolver
      const resolvedPath = this.pathResolver.resolveImagePath(imagePath);
      if (!resolvedPath) {
        // Error handling is already done in PathResolver
        return;
      }

      // Open the image with the default system application using SystemLauncher
      await openWithDefaultApp(resolvedPath);

      // Handle success with optional notification based on settings
      ErrorHandler.handleSuccess(resolvedPath);
    } catch (error) {
      // Handle any unexpected errors that weren't caught by specific handlers
      ErrorHandler.handleGenericError(
        error instanceof Error ? error : new Error(String(error)),
        'image double-click handling',
      );
    }
  }

  /**
   * Checks if a path contains potentially dangerous characters or patterns
   * @param imagePath - The image path to validate
   * @returns True if the path is potentially dangerous
   */
  private isDangerousPath(imagePath: string): boolean {
    // Check for null bytes (can be used for path traversal attacks)
    if (imagePath.includes('\0')) {
      return true;
    }

    // Check for excessive path traversal attempts
    const traversalCount = (imagePath.match(/\.\./g) || []).length;
    if (traversalCount > 5) {
      return true;
    }

    // Check for suspicious patterns that might indicate command injection
    // Be more selective - allow parentheses and brackets in filenames but not other dangerous chars
    const suspiciousPatterns = [
      /[;&|`$]/, // Command injection characters (excluding parentheses and brackets)
      /^\s*[<>]/, // Redirection operators
      /\$\{.*\}/, // Variable expansion
      /`.*`/, // Command substitution
    ];

    return suspiciousPatterns.some((pattern) => pattern.test(imagePath));
  }

  /**
   * Updates the ErrorHandler with current plugin settings
   * Called when settings are changed to ensure proper error handling behavior
   */
  public updateSettings(): void {
    ErrorHandler.initialize(this.plugin.settings);
  }

  /**
   * Registers event listeners for image double-click handling
   */
  public registerEventListeners(): void {
    try {
      // Use event delegation on the document to catch all image double-clicks
      document.addEventListener('dblclick', this.boundHandleDoubleClick, true);
      document.addEventListener('click', this.boundHandleClick, true);
      this.f2KeymapHandler = this.plugin.app.scope.register([], 'F2', (event) =>
        this.handleF2Key(event),
      );
      if (this.plugin.settings.enableDebugLogging) {
        console.debug(
          '[Double-Click Image Opener] Event listeners registered successfully',
        );
      }
    } catch (error) {
      ErrorHandler.handleGenericError(
        error instanceof Error ? error : new Error(String(error)),
        'event listener registration',
      );
    }
  }

  /**
   * Unregisters event listeners for proper cleanup
   */
  public unregisterEventListeners(): void {
    try {
      document.removeEventListener(
        'dblclick',
        this.boundHandleDoubleClick,
        true,
      );
      document.removeEventListener('click', this.boundHandleClick, true);
      if (this.f2KeymapHandler) {
        this.plugin.app.scope.unregister(this.f2KeymapHandler);
        this.f2KeymapHandler = null;
      }
      if (this.plugin.settings.enableDebugLogging) {
        console.debug(
          '[Double-Click Image Opener] Event listeners unregistered successfully',
        );
      }
    } catch (error) {
      ErrorHandler.handleGenericError(
        error instanceof Error ? error : new Error(String(error)),
        'event listener cleanup',
      );
    }
  }
}
