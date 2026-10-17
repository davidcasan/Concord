import { Track } from 'livekit-client';

/** Id estável de uma transmissão de tela (muda a cada nova transmissão). */
export const screenSid = (t) => t.publication?.trackSid;

export const isScreenRef = (t) => t.source === Track.Source.ScreenShare;

/** Posição da tela entre as telas da mesma pessoa (1 ou 2) e quantas ela tem. */
export function screenOrdinal(t, screens) {
  const mine = screens
    .filter((s) => s.participant.identity === t.participant.identity)
    .sort(
      (a, b) =>
        String(a.publication?.trackName).localeCompare(String(b.publication?.trackName)) ||
        String(screenSid(a)).localeCompare(String(screenSid(b))),
    );
  return { index: Math.max(0, mine.indexOf(t)) + 1, count: mine.length };
}

/** Textos de uma tela: rótulo ("Tela de Ana" / "Tela 2 de Ana"), título do popup e chave para lembrar a posição. */
export function describeScreen(t, screens, users) {
  const name = users?.[t.participant.identity]?.displayName || t.participant.name || '…';
  const { index, count } = screenOrdinal(t, screens);
  return {
    name,
    label: count > 1 ? `Tela ${index} de ${name}` : `Tela de ${name}`,
    title: count > 1 ? `${name} — Tela ${index}` : `${name} — Tela`,
    geomKey: `${t.participant.identity}:${index}`,
  };
}
