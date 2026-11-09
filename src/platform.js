// Native (Capacitor / Android) integration with graceful web fallbacks.
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { App } from '@capacitor/app';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform(); // 'android' | 'ios' | 'web'

let hapticsOn = true;
export function setHaptics(on) { hapticsOn = on; }

/** kind: 'light' | 'medium' | 'heavy' | 'success' | 'select' */
export function haptic(kind = 'light') {
  if (!hapticsOn) return;
  try {
    if (isNative) {
      if (kind === 'success') Haptics.notification({ type: NotificationType.Success });
      else if (kind === 'select') Haptics.selectionChanged();
      else Haptics.impact({ style: kind === 'heavy' ? ImpactStyle.Heavy : kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light });
    } else if (navigator.vibrate) {
      navigator.vibrate(kind === 'success' ? [12, 60, 18] : kind === 'heavy' ? 28 : kind === 'medium' ? 18 : 8);
    }
  } catch { /* haptics are best effort */ }
}

/** Android back button: close panels first, then send the app to the background. */
export function onBackButton(handler) {
  if (!isNative) return;
  App.addListener('backButton', () => { if (!handler()) App.minimizeApp(); });
}

/** Pause / resume (both native lifecycle and page visibility). */
export function onPauseResume(pause, resume) {
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : resume()));
  if (isNative) {
    App.addListener('pause', pause);
    App.addListener('resume', resume);
  }
}

export async function appVersion() {
  if (!isNative) return null;
  try { const info = await App.getInfo(); return `${info.version} (${info.build})`; } catch { return null; }
}
