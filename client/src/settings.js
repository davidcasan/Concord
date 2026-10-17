import { useCallback, useState } from 'react';

const KEY = 'minicord.settings';

export const DEFAULT_SETTINGS = {
  micId: '',
  camId: '',
  outId: '',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  micSensitivity: 100,
  micGateEnabled: false,
  micGateCut: -50,
  screenQuality: '1080p30',
  shareAudio: true,
  sounds: true,
  volumes: {}, // identidade (ou identidade:screen) -> 0..1
  lastVolumes: {},
};

export const SCREEN_QUALITIES = {
  '720p30': { width: 1280, height: 720, frameRate: 30, bitrate: 2_000_000, label: '720p · 30 fps' },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, bitrate: 3_500_000, label: '1080p · 30 fps' },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, bitrate: 6_000_000, label: '1080p · 60 fps' },
};

function load() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function useSettings() {
  const [settings, setSettings] = useState(load);
  const update = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // ignora
      }
      return next;
    });
  }, []);
  return [settings, update];
}
