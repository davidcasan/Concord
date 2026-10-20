// minicord-capture: captura uma tela (ou uma janela, recortada da tela) com DXGI Desktop Duplication,
// desenha o cursor por conta própria e escreve os quadros em I420 no stdout.
//
// Por que não a captura do Chromium: ela usa o Windows Graphics Capture, que em alguns Windows some com o
// cursor dentro de jogos em janela sem bordas na tela de quem transmite. A duplicação DXGI não mexe no cursor.
//
// Uso: minicord-capture screen <x> <y> <larguraMax> <alturaMax> <fps>   (x, y: um ponto do monitor, em pixels físicos)
//      minicord-capture window <hwnd> <larguraMax> <alturaMax> <fps>
// stderr: "ok" quando a captura começou; mensagens de erro.
// stdout: quadros = cabeçalho de 12 bytes (uint32 'MCF1', uint16 largura, uint16 altura, uint32 tamanho) + I420.
// Códigos de saída: 0 stdout fechado, 1 erro, 2 monitor indisponível, 3 janela fechada.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

static unsafe class Program
{
    const uint Magic = 0x3146434D; // "MCF1"

    static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (IOException)
        {
            return 0; // o Concord fechou o stdout
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    static int Run(string[] args)
    {
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // coordenadas em pixels físicos
        bool windowMode = args[0] == "window";
        var hwnd = windowMode ? new IntPtr(long.Parse(args[1])) : IntPtr.Zero;
        var point = windowMode ? default : new POINT { X = int.Parse(args[1]), Y = int.Parse(args[2]) };
        int k = windowMode ? 2 : 3;
        int maxW = int.Parse(args[k]), maxH = int.Parse(args[k + 1]), fps = Math.Clamp(int.Parse(args[k + 2]), 1, 60);

        var stdout = Console.OpenStandardOutput();
        var header = new byte[12];
        var cursor = new CursorPainter();
        byte[] output = null;
        int outW = 0, outH = 0, outLen = 0;
        Duplicator dup = null;
        bool announced = false;
        long freq = Stopwatch.Frequency, interval = freq / fps, keepAlive = freq / 2;
        long nextEmit = Stopwatch.GetTimestamp(), lastEmit = 0, failingSince = 0;

        void Write()
        {
            BitConverter.TryWriteBytes(header.AsSpan(0), Magic);
            BitConverter.TryWriteBytes(header.AsSpan(4), (ushort)outW);
            BitConverter.TryWriteBytes(header.AsSpan(6), (ushort)outH);
            BitConverter.TryWriteBytes(header.AsSpan(8), outLen);
            stdout.Write(header, 0, header.Length);
            stdout.Write(output, 0, outLen);
            stdout.Flush();
            lastEmit = Stopwatch.GetTimestamp();
        }

        while (true)
        {
            if (windowMode && !Native.IsWindow(hwnd))
            {
                Console.Error.WriteLine("A janela foi fechada.");
                return 3;
            }
            var monitor = windowMode ? Native.MonitorFromWindow(hwnd, 2) : Native.MonitorFromPoint(point, 2);
            if (dup == null || dup.Monitor != monitor)
            {
                dup?.Dispose();
                dup = null;
                try
                {
                    dup = Duplicator.Open(monitor);
                    failingSince = 0;
                }
                catch (Exception e)
                {
                    long t = Stopwatch.GetTimestamp();
                    if (failingSince == 0) failingSince = t;
                    else if (t - failingSince > 15 * freq)
                    {
                        Console.Error.WriteLine($"Não foi possível capturar o monitor: {e.Message}");
                        return 2;
                    }
                    Thread.Sleep(200);
                    continue;
                }
                if (!announced)
                {
                    Console.Error.WriteLine("ok");
                    Console.Error.Flush();
                    announced = true;
                }
            }

            long now = Stopwatch.GetTimestamp();
            int wait = (int)Math.Max(1, (nextEmit - now) * 1000 / freq);
            try
            {
                dup.Poll(wait);
            }
            catch (Exception)
            {
                dup.Dispose(); // placa de vídeo reiniciada, monitor desligado...: reabre na próxima volta
                dup = null;
                continue;
            }

            now = Stopwatch.GetTimestamp();
            if (now < nextEmit) continue;
            nextEmit = Math.Max(nextEmit + interval, now - interval); // não acumula atraso

            // Região capturada, relativa ao monitor.
            int sx = 0, sy = 0, sw = dup.Width, sh = dup.Height;
            if (windowMode)
            {
                if (Native.IsIconic(hwnd) || Native.DwmGetWindowAttribute(hwnd, 9, out RECT r, sizeof(RECT)) != 0)
                {
                    if (output != null && now - lastEmit > keepAlive) Write(); // minimizada: repete o último quadro
                    continue;
                }
                int left = Math.Max(r.Left, dup.Bounds.Left) - dup.Bounds.Left;
                int top = Math.Max(r.Top, dup.Bounds.Top) - dup.Bounds.Top;
                int right = Math.Min(Math.Min(r.Right, dup.Bounds.Right) - dup.Bounds.Left, dup.Width);
                int bottom = Math.Min(Math.Min(r.Bottom, dup.Bounds.Bottom) - dup.Bounds.Top, dup.Height);
                if (right - left < 2 || bottom - top < 2) continue;
                (sx, sy, sw, sh) = (left, top, right - left, bottom - top);
            }

            bool cursorChanged = cursor.Update();
            bool sizeChanged = output == null || Fit(sw, sh, maxW, maxH) != (outW, outH);
            if (!dup.Dirty && !cursorChanged && !sizeChanged && now - lastEmit < keepAlive) continue;
            if (!dup.Load()) continue; // ainda sem imagem

            (outW, outH) = Fit(sw, sh, maxW, maxH);
            outLen = outW * outH * 3 / 2;
            if (output == null || output.Length < outLen) output = new byte[outLen];
            cursor.Draw(dup.Frame, dup.Width, dup.Height, dup.Bounds.Left, dup.Bounds.Top);
            Convert.ToI420(dup.Frame, dup.Width * 4, sx, sy, sw, sh, output, outW, outH);
            cursor.Restore(dup.Frame, dup.Width);
            Write();
        }
    }

    // Cabe em larguraMax x alturaMax mantendo a proporção, sem ampliar; dimensões pares (exigência do I420).
    static (int, int) Fit(int w, int h, int maxW, int maxH)
    {
        double s = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / h));
        return (Math.Max(2, (int)(w * s) & ~1), Math.Max(2, (int)(h * s) & ~1));
    }
}

/// <summary>Duplicação DXGI de um monitor, com reconexão quando o Windows corta o acesso.</summary>
sealed unsafe class Duplicator : IDisposable
{
    const int NotFound = unchecked((int)0x887A0002);
    const int InvalidCall = unchecked((int)0x887A0001);
    const int AccessLost = unchecked((int)0x887A0026);
    const int WaitTimeout = unchecked((int)0x887A0027);
    static readonly Guid IID_IDXGIFactory1 = new("770aae78-f26f-4dba-a829-253c83d1b387");
    static readonly Guid IID_IDXGIOutput1 = new("00cddea8-939b-4b83-a340-a685226666cc");
    static readonly Guid IID_ID3D11Texture2D = new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

    public IntPtr Monitor { get; private set; }
    public RECT Bounds; // posição do monitor na área de trabalho (pixels físicos)
    public int Width, Height; // tamanho da imagem duplicada
    public byte[] Frame; // última imagem, BGRA
    public bool Dirty; // há imagem nova na textura de leitura que ainda não foi copiada para Frame
    bool hasImage;
    // Logo depois de cada reconexão o Windows entrega, uma vez, a cópia que guardou da tela, que pode ser bem
    // antiga (com o jogo em janela sem bordas, uma tela de carregamento de minutos atrás). Ela chega como 1ª ou
    // 2ª imagem e, mostrada, vira um "pisca". A 1ª imagem de cada reconexão é descartada e sua assinatura fica
    // guardada por 1 s; imagens com a mesma assinatura também são descartadas.
    bool firstAfterReconnect;
    readonly Dictionary<ulong, long> staleImages = new();

    // Diagnóstico (MINICORD_CAPTURE_DEBUG=arquivo): uma linha por imagem recebida do Windows.
    static readonly StreamWriter debug = Environment.GetEnvironmentVariable("MINICORD_CAPTURE_DEBUG") is { Length: > 0 } p
        ? new StreamWriter(p) { AutoFlush = true }
        : null;
    int generation;

    // staging: imagem atual (lida pelo Load). probe: onde cada imagem nova é examinada; se aceita, as duas trocam.
    IntPtr output1, device, context, dupl, staging, probe;

    static IntPtr Vt(IntPtr obj, int index) => ((IntPtr*)*(IntPtr*)obj)[index];

    static void Check(int hr)
    {
        if (hr < 0) throw new COMException($"HRESULT 0x{hr:X8}", hr);
    }

    static void Release(ref IntPtr p)
    {
        if (p != IntPtr.Zero) Marshal.Release(p);
        p = IntPtr.Zero;
    }

    public static Duplicator Open(IntPtr monitor)
    {
        var d = new Duplicator();
        try
        {
            d.Init(monitor);
            return d;
        }
        catch
        {
            d.Dispose();
            throw;
        }
    }

    void Init(IntPtr monitor)
    {
        var fid = IID_IDXGIFactory1;
        Check(Native.CreateDXGIFactory1(ref fid, out var factory));
        byte* desc = stackalloc byte[96]; // DXGI_OUTPUT_DESC
        try
        {
            for (uint a = 0; ; a++)
            {
                IntPtr adapter;
                int hr = ((delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, int>)Vt(factory, 12))(factory, a, &adapter); // EnumAdapters1
                if (hr == NotFound) break;
                Check(hr);
                try
                {
                    for (uint o = 0; ; o++)
                    {
                        IntPtr output;
                        hr = ((delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, int>)Vt(adapter, 7))(adapter, o, &output); // EnumOutputs
                        if (hr == NotFound) break;
                        Check(hr);
                        try
                        {
                            Check(((delegate* unmanaged[Stdcall]<IntPtr, byte*, int>)Vt(output, 7))(output, desc)); // GetDesc
                            if (*(IntPtr*)(desc + 88) != monitor) continue;
                            Bounds = *(RECT*)(desc + 64);
                            Monitor = monitor;
                            // O dispositivo precisa ser da placa ligada a este monitor.
                            Check(Native.D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out _, out context));
                            var o1 = IID_IDXGIOutput1;
                            Check(Marshal.QueryInterface(output, ref o1, out output1));
                            Width = Bounds.Right - Bounds.Left;
                            Height = Bounds.Bottom - Bounds.Top;
                            Frame = new byte[Width * Height * 4];
                            Check(Duplicate());
                            return;
                        }
                        finally
                        {
                            Marshal.Release(output);
                        }
                    }
                }
                finally
                {
                    Marshal.Release(adapter);
                }
            }
        }
        finally
        {
            Marshal.Release(factory);
        }
        throw new InvalidOperationException("Monitor não encontrado.");
    }

    int Duplicate()
    {
        IntPtr d;
        int hr = ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr*, int>)Vt(output1, 22))(output1, device, &d); // DuplicateOutput
        if (hr >= 0) dupl = d;
        return hr;
    }

    /// <summary>Espera uma imagem nova por até timeoutMs e a deixa na textura de leitura.</summary>
    public void Poll(int timeoutMs)
    {
        // Sem duplicação (acesso cortado, tela de bloqueio/UAC): tenta de novo e mantém a última imagem.
        if (dupl == IntPtr.Zero)
        {
            if (Duplicate() < 0)
            {
                Thread.Sleep(Math.Clamp(timeoutMs, 1, 50));
                return;
            }
            firstAfterReconnect = hasImage || Dirty;
            generation++;
        }
        byte* info = stackalloc byte[48]; // DXGI_OUTDUPL_FRAME_INFO
        IntPtr resource;
        int hr = ((delegate* unmanaged[Stdcall]<IntPtr, uint, byte*, IntPtr*, int>)Vt(dupl, 8))(dupl, (uint)timeoutMs, info, &resource); // AcquireNextFrame
        if (hr == WaitTimeout) return;
        if (hr < 0)
        {
            // Jogos em janela sem bordas fazem o Windows cortar o acesso várias vezes por segundo: só recria a duplicação.
            Release(ref dupl);
            if (hr != AccessLost && hr != InvalidCall) throw new COMException($"HRESULT 0x{hr:X8}", hr);
            return;
        }
        try
        {
            if (*(uint*)(info + 16) == 0) return; // AccumulatedFrames: só o ponteiro mudou
            var tid = IID_ID3D11Texture2D;
            Check(Marshal.QueryInterface(resource, ref tid, out var texture));
            try
            {
                EnsureStaging(texture);
                ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr, void>)Vt(context, 47))(context, probe, texture); // CopyResource
                bool hashed = TryHash(probe, out ulong hash);
                long now = Environment.TickCount64;
                bool stale;
                if (firstAfterReconnect)
                {
                    firstAfterReconnect = false;
                    stale = true;
                    if (hashed) RememberStale(hash, now);
                }
                else
                {
                    stale = hashed && staleImages.TryGetValue(hash, out long seen) && now - seen <= 1000;
                }
                debug?.WriteLine($"{now},{generation},{hash:X16},{(stale ? 1 : 0)}");
                if (stale) return;
                (staging, probe) = (probe, staging);
                Dirty = true;
            }
            finally
            {
                Marshal.Release(texture);
            }
        }
        finally
        {
            Marshal.Release(resource);
            ((delegate* unmanaged[Stdcall]<IntPtr, int>)Vt(dupl, 14))(dupl); // ReleaseFrame
        }
    }

    // Assinatura (FNV-1a) de uma amostra de pixels (1 a cada 16 em cada 16ª linha).
    bool TryHash(IntPtr texture, out ulong hash)
    {
        hash = 14695981039346656037;
        byte* mapped = stackalloc byte[16]; // D3D11_MAPPED_SUBRESOURCE
        if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, int, uint, byte*, int>)Vt(context, 14))(context, texture, 0, 1, 0, mapped) < 0) return false; // Map(READ)
        try
        {
            byte* src = *(byte**)mapped;
            int pitch = *(int*)(mapped + 8);
            for (int y = 8; y < Height; y += 16)
            {
                uint* row = (uint*)(src + (long)y * pitch);
                for (int x = 8; x < Width; x += 16) hash = (hash ^ row[x]) * 1099511628211;
            }
            return true;
        }
        finally
        {
            ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, void>)Vt(context, 15))(context, texture, 0); // Unmap
        }
    }

    void RememberStale(ulong hash, long now)
    {
        staleImages[hash] = now;
        if (staleImages.Count <= 16) return;
        foreach (var (key, seen) in staleImages)
            if (now - seen > 1000) staleImages.Remove(key);
    }

    void EnsureStaging(IntPtr texture)
    {
        byte* desc = stackalloc byte[44]; // D3D11_TEXTURE2D_DESC
        ((delegate* unmanaged[Stdcall]<IntPtr, byte*, void>)Vt(texture, 10))(texture, desc); // GetDesc
        int w = *(int*)desc, h = *(int*)(desc + 4);
        if (staging != IntPtr.Zero && probe != IntPtr.Zero && w == Width && h == Height) return;
        Release(ref staging);
        Release(ref probe);
        *(uint*)(desc + 8) = 1; // MipLevels
        *(uint*)(desc + 12) = 1; // ArraySize
        *(uint*)(desc + 20) = 1; // SampleDesc.Count
        *(uint*)(desc + 24) = 0; // SampleDesc.Quality
        *(uint*)(desc + 28) = 3; // D3D11_USAGE_STAGING
        *(uint*)(desc + 32) = 0; // BindFlags
        *(uint*)(desc + 36) = 0x20000; // D3D11_CPU_ACCESS_READ
        *(uint*)(desc + 40) = 0; // MiscFlags
        IntPtr created;
        Check(((delegate* unmanaged[Stdcall]<IntPtr, byte*, IntPtr, IntPtr*, int>)Vt(device, 5))(device, desc, IntPtr.Zero, &created)); // CreateTexture2D
        staging = created;
        Check(((delegate* unmanaged[Stdcall]<IntPtr, byte*, IntPtr, IntPtr*, int>)Vt(device, 5))(device, desc, IntPtr.Zero, &created));
        probe = created;
        if (w != Width || h != Height)
        {
            (Width, Height) = (w, h);
            Frame = new byte[w * h * 4];
            hasImage = false;
            Dirty = false; // a imagem pendente era do tamanho antigo
        }
    }

    /// <summary>Copia a imagem nova (se houver) para Frame. Retorna se já existe alguma imagem.</summary>
    public bool Load()
    {
        if (!Dirty) return hasImage;
        Dirty = false;
        byte* mapped = stackalloc byte[16]; // D3D11_MAPPED_SUBRESOURCE
        if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, int, uint, byte*, int>)Vt(context, 14))(context, staging, 0, 1, 0, mapped) < 0) return hasImage; // Map(READ)
        try
        {
            byte* src = *(byte**)mapped;
            int pitch = *(int*)(mapped + 8), row = Width * 4;
            fixed (byte* dst = Frame)
            {
                for (int y = 0; y < Height; y++) Buffer.MemoryCopy(src + (long)y * pitch, dst + (long)y * row, row, row);
            }
            hasImage = true;
        }
        finally
        {
            ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, void>)Vt(context, 15))(context, staging, 0); // Unmap
        }
        return true;
    }

    public void Dispose()
    {
        Release(ref dupl);
        Release(ref staging);
        Release(ref probe);
        Release(ref output1);
        Release(ref context);
        Release(ref device);
    }
}

/// <summary>Cursor do Windows (o real, inclusive o de jogos) desenhado sobre a imagem capturada.</summary>
sealed unsafe class CursorPainter
{
    IntPtr handle;
    int width, height, hotX, hotY;
    uint[] pixels; // BGRA com alfa
    bool[] invert; // pixels que invertem o fundo (cursores monocromáticos, como o I-beam)
    int x, y, lastX, lastY;
    bool visible, lastVisible;
    IntPtr lastHandle;
    uint[] saved = Array.Empty<uint>();
    int savedX, savedY, savedW, savedH;

    /// <summary>Lê posição e formato atuais. Retorna se algo mudou desde a última chamada.</summary>
    public bool Update()
    {
        var ci = new CURSORINFO { cbSize = sizeof(CURSORINFO) };
        visible = Native.GetCursorInfo(ref ci) && (ci.flags & 1) != 0 && ci.hCursor != IntPtr.Zero;
        if (visible)
        {
            if (ci.hCursor != handle) Load(ci.hCursor);
            (x, y) = (ci.pt.X, ci.pt.Y);
        }
        bool changed = visible != lastVisible || x != lastX || y != lastY || handle != lastHandle;
        (lastVisible, lastX, lastY, lastHandle) = (visible, x, y, handle);
        return changed;
    }

    void Load(IntPtr h)
    {
        handle = h;
        pixels = null;
        if (!Native.GetIconInfo(h, out var ii)) return;
        try
        {
            if (Native.GetObjectW(ii.hbmMask, sizeof(BITMAP), out var bm) == 0) return;
            int w = bm.bmWidth, fullH = bm.bmHeight, hh = ii.hbmColor != IntPtr.Zero ? fullH : fullH / 2;
            if (w <= 0 || hh <= 0) return;
            var mask = ReadBits(ii.hbmMask, w, fullH);
            var color = ii.hbmColor != IntPtr.Zero ? ReadBits(ii.hbmColor, w, hh) : null;
            var px = new uint[w * hh];
            var inv = new bool[w * hh];
            if (color != null)
            {
                bool hasAlpha = false;
                foreach (var c in color) hasAlpha |= (c >> 24) != 0;
                for (int i = 0; i < px.Length; i++)
                {
                    if (hasAlpha) px[i] = color[i];
                    else if ((mask[i] & 0xFFFFFF) == 0) px[i] = color[i] | 0xFF000000;
                    else if ((color[i] & 0xFFFFFF) != 0) inv[i] = true;
                }
            }
            else
            {
                // Monocromático: metade de cima é a máscara AND, metade de baixo a XOR.
                for (int i = 0; i < px.Length; i++)
                {
                    bool and = (mask[i] & 0xFFFFFF) != 0, xor = (mask[i + px.Length] & 0xFFFFFF) != 0;
                    if (!and) px[i] = xor ? 0xFFFFFFFF : 0xFF000000;
                    else if (xor) inv[i] = true;
                }
            }
            (width, height, hotX, hotY, pixels, invert) = (w, hh, ii.xHotspot, ii.yHotspot, px, inv);
        }
        finally
        {
            if (ii.hbmMask != IntPtr.Zero) Native.DeleteObject(ii.hbmMask);
            if (ii.hbmColor != IntPtr.Zero) Native.DeleteObject(ii.hbmColor);
        }
    }

    static uint[] ReadBits(IntPtr bitmap, int w, int h)
    {
        var bits = new uint[w * h];
        var bi = new BITMAPINFOHEADER { biSize = (uint)sizeof(BITMAPINFOHEADER), biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32 };
        var dc = Native.GetDC(IntPtr.Zero);
        try
        {
            fixed (uint* p = bits) Native.GetDIBits(dc, bitmap, 0, (uint)h, p, ref bi, 0);
        }
        finally
        {
            Native.ReleaseDC(IntPtr.Zero, dc);
        }
        return bits;
    }

    /// <summary>Desenha o cursor na imagem (guardando o que ficou por baixo para Restore).</summary>
    public void Draw(byte[] frame, int fw, int fh, int originX, int originY)
    {
        savedW = savedH = 0;
        if (!visible || pixels == null) return;
        int left = x - hotX - originX, top = y - hotY - originY;
        int x0 = Math.Max(0, left), y0 = Math.Max(0, top);
        int x1 = Math.Min(fw, left + width), y1 = Math.Min(fh, top + height);
        if (x1 <= x0 || y1 <= y0) return;
        (savedX, savedY, savedW, savedH) = (x0, y0, x1 - x0, y1 - y0);
        if (saved.Length < savedW * savedH) saved = new uint[savedW * savedH];
        fixed (byte* f = frame)
        {
            var dst = (uint*)f;
            for (int py = y0; py < y1; py++)
            {
                for (int px = x0; px < x1; px++)
                {
                    uint* d = dst + (long)py * fw + px;
                    saved[(py - y0) * savedW + (px - x0)] = *d;
                    int i = (py - top) * width + (px - left);
                    if (invert[i])
                    {
                        *d ^= 0x00FFFFFF;
                        continue;
                    }
                    uint s = pixels[i], a = s >> 24;
                    if (a == 0) continue;
                    if (a == 255)
                    {
                        *d = s;
                        continue;
                    }
                    uint o = *d, na = 255 - a;
                    uint b = ((s & 0xFF) * a + (o & 0xFF) * na) / 255;
                    uint g = (((s >> 8) & 0xFF) * a + ((o >> 8) & 0xFF) * na) / 255;
                    uint r = (((s >> 16) & 0xFF) * a + ((o >> 16) & 0xFF) * na) / 255;
                    *d = 0xFF000000 | (r << 16) | (g << 8) | b;
                }
            }
        }
    }

    public void Restore(byte[] frame, int fw)
    {
        if (savedW == 0) return;
        fixed (byte* f = frame)
        {
            var dst = (uint*)f;
            for (int py = 0; py < savedH; py++)
                for (int px = 0; px < savedW; px++) dst[(long)(savedY + py) * fw + savedX + px] = saved[py * savedW + px];
        }
    }
}

static unsafe class Convert
{
    /// <summary>
    /// Recorta (sx, sy, sw, sh) da imagem BGRA, redimensiona (bilinear) para dw x dh e converte para I420 (BT.601, faixa limitada).
    /// </summary>
    public static void ToI420(byte[] src, int stride, int sx, int sy, int sw, int sh, byte[] dst, int dw, int dh)
    {
        var xs = Taps(sx, sw, dw);
        var ys = Taps(sy, sh, dh);
        int ySize = dw * dh, cw = dw / 2;
        Parallel.For(0, dh / 2, j =>
        {
            fixed (byte* s = src, d = dst)
            fixed (int* xt = xs, yt = ys)
            {
                byte* yp = d, up = d + ySize, vp = d + ySize + ySize / 4;
                for (int i = 0; i < dw; i += 2)
                {
                    int sr = 0, sg = 0, sb = 0;
                    for (int dy = 0; dy < 2; dy++)
                    {
                        int row = 2 * j + dy;
                        for (int dx = 0; dx < 2; dx++)
                        {
                            Sample(s, stride, xt + (i + dx) * 3, yt + row * 3, out int r, out int g, out int b);
                            yp[row * dw + i + dx] = (byte)(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
                            sr += r;
                            sg += g;
                            sb += b;
                        }
                    }
                    sr >>= 2;
                    sg >>= 2;
                    sb >>= 2;
                    up[j * cw + i / 2] = (byte)(((-38 * sr - 74 * sg + 112 * sb + 128) >> 8) + 128);
                    vp[j * cw + i / 2] = (byte)(((112 * sr - 94 * sg - 18 * sb + 128) >> 8) + 128);
                }
            }
        });
    }

    // Para cada pixel de destino: índice do pixel de origem, índice do vizinho e peso (0..256) do vizinho.
    static int[] Taps(int start, int srcLen, int dstLen)
    {
        var t = new int[dstLen * 3];
        for (int i = 0; i < dstLen; i++)
        {
            long pos = Math.Max(0, ((2L * i + 1) * srcLen * 256) / (2L * dstLen) - 128);
            int p0 = (int)(pos >> 8), frac = (int)(pos & 255);
            if (p0 >= srcLen - 1)
            {
                p0 = srcLen - 1;
                frac = 0;
            }
            t[i * 3] = start + p0;
            t[i * 3 + 1] = start + Math.Min(p0 + 1, srcLen - 1);
            t[i * 3 + 2] = frac;
        }
        return t;
    }

    static void Sample(byte* s, int stride, int* xt, int* yt, out int r, out int g, out int b)
    {
        int fx = xt[2], fy = yt[2];
        byte* p00 = s + (long)yt[0] * stride + xt[0] * 4;
        if (fx == 0 && fy == 0)
        {
            (b, g, r) = (p00[0], p00[1], p00[2]);
            return;
        }
        byte* p10 = s + (long)yt[0] * stride + xt[1] * 4;
        byte* p01 = s + (long)yt[1] * stride + xt[0] * 4;
        byte* p11 = s + (long)yt[1] * stride + xt[1] * 4;
        int w00 = (256 - fx) * (256 - fy), w10 = fx * (256 - fy), w01 = (256 - fx) * fy, w11 = fx * fy;
        b = (p00[0] * w00 + p10[0] * w10 + p01[0] * w01 + p11[0] * w11) >> 16;
        g = (p00[1] * w00 + p10[1] * w10 + p01[1] * w01 + p11[1] * w11) >> 16;
        r = (p00[2] * w00 + p10[2] * w10 + p01[2] * w01 + p11[2] * w11) >> 16;
    }
}

[StructLayout(LayoutKind.Sequential)]
struct POINT
{
    public int X, Y;
}

[StructLayout(LayoutKind.Sequential)]
struct RECT
{
    public int Left, Top, Right, Bottom;
}

[StructLayout(LayoutKind.Sequential)]
struct CURSORINFO
{
    public int cbSize, flags;
    public IntPtr hCursor;
    public POINT pt;
}

[StructLayout(LayoutKind.Sequential)]
struct ICONINFO
{
    public int fIcon, xHotspot, yHotspot;
    public IntPtr hbmMask, hbmColor;
}

[StructLayout(LayoutKind.Sequential)]
struct BITMAP
{
    public int bmType, bmWidth, bmHeight, bmWidthBytes;
    public ushort bmPlanes, bmBitsPixel;
    public IntPtr bmBits;
}

[StructLayout(LayoutKind.Sequential)]
struct BITMAPINFOHEADER
{
    public uint biSize;
    public int biWidth, biHeight;
    public ushort biPlanes, biBitCount;
    public uint biCompression, biSizeImage;
    public int biXPelsPerMeter, biYPelsPerMeter;
    public uint biClrUsed, biClrImportant;
}

static unsafe class Native
{
    [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
    [DllImport("d3d11.dll")] public static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint numLevels, uint sdkVersion, out IntPtr device, out int level, out IntPtr context);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
    [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
    [DllImport("gdi32.dll")] public static extern int GetObjectW(IntPtr obj, int size, out BITMAP bitmap);
    [DllImport("gdi32.dll")] public static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, void* bits, ref BITMAPINFOHEADER info, uint usage);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
}
