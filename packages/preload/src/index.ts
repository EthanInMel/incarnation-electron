import {sha256sum} from './nodeCrypto.js';
import {versions} from './versions.js';
import {ipcRenderer} from 'electron';

const listenersMap: Map<string, WeakMap<Function, (...args: any[]) => void>> = new Map();

function getWrappedListener(channel: string, handler: (data: any) => void) {
  let wm = listenersMap.get(channel);
  if (!wm) {
    wm = new WeakMap();
    listenersMap.set(channel, wm);
  }
  let wrapped = wm.get(handler as any);
  if (!wrapped) {
    wrapped = (_e: unknown, data: any) => {
      try { handler(data); } catch {}
    };
    wm.set(handler as any, wrapped);
  }
  return wrapped;
}

export function ipcOn(channel: string, handler: (data: any) => void) {
  try { console.log('[preload] ipcOn()', {channel}); } catch {}
  const wrapped = getWrappedListener(channel, handler);
  ipcRenderer.on(channel, wrapped);
}

export function ipcOff(channel: string, handler: (data: any) => void) {
  try { console.log('[preload] ipcOff()', {channel}); } catch {}
  const wrapped = listenersMap.get(channel)?.get(handler as any);
  if (wrapped) {
    ipcRenderer.removeListener(channel, wrapped);
  }
}

function send(channel: string, message: unknown) {
  try {
    const preview = (() => {
      try {
        const obj = typeof message === 'object' && message ? {...(message as any)} : {value: message};
        if (obj && typeof obj === 'object') {
          if ('apiKey' in obj) obj.apiKey = '[redacted]';
          if ('bridgeToken' in obj) obj.bridgeToken = '[redacted]';
        }
        return obj;
      } catch {
        return {value: '[unserializable]'};
      }
    })();
    console.log('[preload] send()', {channel, preview});
  } catch {}
  return ipcRenderer.invoke(channel, message as any);
}

export {sha256sum, versions, send};

export function ipcInvoke(channel: string, message?: unknown) {
  try { console.log('[preload] ipcInvoke()', {channel}); } catch {}
  return ipcRenderer.invoke(channel, message as any);
}
