// Flags the content scripts and the Instagram extractor keep on the page's
// window (loaded-once guards, extractor state read by the service worker's probe).
interface Window {
  __vdlBadgeLoaded?: boolean;
  __vdlBadgeScanTimer?: ReturnType<typeof setInterval>;
  __videoDownloaderScannerLoaded?: boolean;
  __vdlSiteBridge?: boolean;
  __vdlInstagramVersion?: number;
  __vdlInstagramHooked?: boolean;
  __vdlInstagramStats?: Record<string, unknown>;
}
