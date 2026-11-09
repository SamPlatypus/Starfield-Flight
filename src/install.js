// "Install app" support for the web build:
//   - Chrome / Edge / Samsung Internet on Android and desktop fire `beforeinstallprompt`;
//     we keep the event and show our own Install button, which opens the native prompt.
//   - iOS Safari has no prompt: we explain Share -> Add to Home Screen.
//   - On Android the signed APK from the latest GitHub release can be sideloaded instead.
// Inside the Capacitor (APK) build the app is already installed, so none of this shows.
import { isNative } from './platform.js';

export const APK_URL = 'https://github.com/SamPlatypus/Starfield-Flight/releases/latest/download/starfield-flight.apk';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches ||
    matchMedia('(display-mode: minimal-ui)').matches || navigator.standalone === true;
}

export class Installer {
  constructor(onChange) {
    this.onChange = onChange;
    this.deferred = null;
    this.installed = isNative || isStandalone();
    if (isNative) return;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferred = e;
      this.onChange?.();
    });
    window.addEventListener('appinstalled', () => {
      this.installed = true;
      this.deferred = null;
      this.onChange?.('installed');
    });
  }

  /** Whether the in-app Install UI applies at all (web, not yet installed). */
  get relevant() { return !isNative && !this.installed; }
  get canPrompt() { return !!this.deferred; }

  async prompt() {
    if (!this.deferred) return 'unavailable';
    const e = this.deferred;
    this.deferred = null;
    await e.prompt();
    const { outcome } = await e.userChoice;
    this.onChange?.(outcome);
    return outcome;
  }

  instructions() {
    if (this.canPrompt) return 'Installs Starfield Flight as a full-screen app that works with no connection.';
    if (isIOS) return 'On iPhone or iPad: tap Share, then “Add to Home Screen”. It then runs full screen and offline.';
    if (isAndroid) return 'Use the browser menu (⋮) → “Install app” / “Add to Home screen”, or download the Android APK.';
    return 'Use your browser’s “Install app” option (address bar or menu) to run it full screen and offline.';
  }
}
