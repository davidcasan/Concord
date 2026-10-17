export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const AVATAR_SIZE = 512;

/**
 * Valida a foto escolhida (até 10 MB) e a prepara para envio: recorta no centro em quadrado e reduz para
 * no máximo 512×512. Assim a foto original pode ser grande, mas ninguém baixa megabytes para ver um avatar de 32 px.
 * GIFs animados viram imagem estática (primeiro quadro).
 */
export async function prepareAvatar(file) {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  if (file.size > AVATAR_MAX_BYTES) {
    throw new Error(`A foto tem ${(file.size / 1024 / 1024).toFixed(1)} MB. O limite é 10 MB.`);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Não foi possível ler essa imagem. Use PNG, JPG, WebP ou GIF.');
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const size = Math.min(AVATAR_SIZE, side);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);

    const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    // WebP é menor; se o navegador não gerar, cai para PNG (que também aceita transparência).
    let blob = await toBlob('image/webp', 0.9);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/png');
    if (!blob) throw new Error('Não foi possível preparar a imagem.');
    return blob;
  } finally {
    bitmap.close?.();
  }
}
