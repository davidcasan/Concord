# Concord

Um mini Discord para você e seus amigos: login individual, salas de texto e de voz, microfone, câmera e compartilhamento de tela com áudio.

## O que tem

- **Contas com usuário e senha** (senhas guardadas com hash scrypt). Só entra quem tiver o **código de convite**. A primeira conta criada vira **admin**.
- **Salas de texto**: histórico salvo, "fulano está digitando…", links clicáveis e pré-visualização de imagens por link. Dá para apagar suas mensagens.
- **Salas de voz**: microfone, mutar, ensurdecer, câmera, compartilhamento de tela com áudio, indicador de quem está falando, volume individual do microfone por pessoa na lista da sala e janela flutuante para transmissões de tela.
- **Criar, renomear e apagar salas**. Quem criou a sala ou o admin pode mexer nela.
- **Configurações**: nome de exibição, cor, troca de senha, escolha de microfone, câmera e saída de áudio, supressão de ruído, cancelamento de eco e teste de microfone.
- **App desktop (Windows)** com seletor de tela/janela e captura do **áudio do computador**.
- **Painel Concord Server (Windows)** para ligar e desligar o servidor sem abrir uma janela de console.

## Como funciona

```
[navegador ou app desktop] ──HTTP/WebSocket──► server/ (Node: login, salas, chat, presença)
           │                                         │ gera tokens
           └────────────voz/vídeo (WebRTC)──────► LiveKit (local em livekit/ ou LiveKit Cloud)
```

- `server/`: Node + Express + Socket.io + SQLite embutido do Node (arquivo `data/minicord.db`, mantido para compatibilidade com os dados existentes).
- `client/`: React + Vite + LiveKit.
- `desktop/`: Electron.
- `livekit/`: servidor de mídia LiveKit, que o `npm start` inicia sozinho.

---

## 1. Rodar pela primeira vez (no seu PC)

Precisa do Node 22.13+ (você já tem o 24).

```powershell
cd C:\Users\satan\source\minicord
npm run setup     # instala tudo, gera .env com chaves e código de convite, compila a interface
npm start         # sobe o site em http://localhost:666 (e o LiveKit local junto)
```

O terminal mostra o **código de convite**. Ele também fica salvo no arquivo `.env`.

Abra http://localhost:666, clique em **Criar conta** e crie a sua (ela vira a de admin).

Para usar o app desktop no seu PC:

```powershell
npm run desktop:install   # só na primeira vez
npm run desktop           # abre o app; informe http://localhost:666
```

Na primeira vez, o Windows pode pedir para liberar o `node.exe` e o `livekit-server.exe` no firewall. Aceite.

---

## 2. Usar com os amigos pela internet

Seus amigos precisam alcançar duas coisas: o **site** (porta 666) e o **servidor de voz**. O jeito mais simples, sem mexer no roteador:

### Opção recomendada: ngrok (site) + LiveKit Cloud (voz/vídeo)

1. **LiveKit Cloud** (grátis): crie uma conta em https://cloud.livekit.io e um projeto. Em *Settings → Keys*, copie a URL (`wss://...livekit.cloud`), a API Key e a API Secret. Depois edite o `.env`:
   ```
   LIVEKIT_URL=wss://seu-projeto.livekit.cloud
   LIVEKIT_API_KEY=APIxxxxxxxx
   LIVEKIT_API_SECRET=xxxxxxxxxxxx
   LIVEKIT_LOCAL=false
   ```
   Com o servidor executável, edite `%LOCALAPPDATA%\Concord Server\.env` (criado na primeira execução) e reinicie-o.
2. **ngrok** (você já tem em `C:\Users\satan\ngrok`). No painel do ngrok, pegue o seu **domínio estático grátis** (*Domains*). Então:
   ```powershell
   npm start
   # em outro terminal:
   C:\Users\satan\ngrok\ngrok.exe http --url=SEU-DOMINIO.ngrok-free.app 666
   ```
3. Mande para os amigos:
   - o endereço `https://SEU-DOMINIO.ngrok-free.app`
   - o código de convite
   - o instalador `desktop\dist\Concord Setup 1.0.0.exe` (ou o `Concord-portatil.exe`, que nem precisa instalar)

   Eles também podem usar pelo navegador (Chrome/Edge), direto no endereço.

> Dica: crie o arquivo `desktop/default-server.json` com `{"serverUrl": "https://SEU-DOMINIO.ngrok-free.app"}` e rode `npm run desktop:dist`. O app gerado já abre apontando para o seu servidor, sem perguntar o endereço.

O site só funciona enquanto o seu PC estiver ligado com o `npm start` e o ngrok rodando.

### Executáveis para distribuir no Windows

Instale as dependências do app desktop uma vez com `npm run desktop:install` e gere as distribuições com `npm run dist`:

- `server/dist/Concord Server.exe`: aplicativo único do servidor, com o núcleo integrado. Use **Iniciar servidor** e **Desligar servidor**; ao fechar o painel, o servidor e o LiveKit também são encerrados. O painel mostra o código de convite e os endereços de acesso.
- `desktop/dist/Concord Setup 1.0.0.exe`: instalador do cliente para todos os usuários do Windows (pode pedir permissão de administrador).
- `desktop/dist/Concord-portatil.exe`: cliente portátil, sem instalação.

Execute `Concord Server.exe` no computador que ficará ligado e passe aos amigos o endereço dele, o código de convite e o instalador ou cliente portátil. Contas e banco existentes são copiados automaticamente de `%LOCALAPPDATA%\Minicord Server` para `%LOCALAPPDATA%\Concord Server` na primeira inicialização, mantendo a pasta anterior intacta. O banco continua se chamando `data/minicord.db` para preservar os dados. Na rede local, o endereço é `http://IP-DO-SERVIDOR:666`; para acesso pela internet, configure HTTPS/ngrok e o LiveKit Cloud como descrito acima.

#### Acesso direto pelo IP externo

Configure `serverUrl` e `fallbackServerUrl` em `desktop/default-server.json` com os endereços público e local do seu servidor antes de gerar o cliente. Esse arquivo contém endereços específicos da instalação e não é incluído no Git; o painel do servidor incorpora a configuração local ao ser gerado. O aplicativo tenta primeiro o endereço local e, se não estiver na mesma rede, passa ao endereço público. Isso evita depender do NAT loopback do roteador para a sinalização. Reserve o endereço local do PC servidor no roteador para que ele não mude.

Para acesso externo com o LiveKit local, encaminhe no roteador para o IP local fixo do computador servidor:

- TCP: `666`, `7880` e `7881`
- UDP: `50000–50100`

No Windows, abra o PowerShell como administrador no computador servidor e adicione as regras:

```powershell
New-NetFirewallRule -DisplayName "Concord externo TCP" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 666,7880,7881
New-NetFirewallRule -DisplayName "Concord externo UDP" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 50000-50100
```

O servidor LiveKit anuncia o IP externo para a mídia. Teste de uma rede diferente, como os dados móveis do celular. Se o roteador estiver sob CGNAT, o encaminhamento direto não funcionará. Clientes de navegador não fazem a troca automática de endereço: para usar o mesmo IP público dentro e fora da rede, o roteador precisa suportar e ter habilitado NAT loopback/hairpin; sem isso, use o app desktop com a alternativa local configurada.

**Atenção:** o acesso direto usa HTTP/WS sem criptografia para login e sinalização. Não use essa configuração para enviar senhas que você não aceitaria expor na rede. Para uso pela internet, prefira HTTPS com ngrok e LiveKit Cloud, como descrito acima.

### Alternativa: Tailscale (tudo no seu PC, sem LiveKit Cloud)

Todo mundo instala o [Tailscale](https://tailscale.com) e entra na mesma rede. Deixe `LIVEKIT_URL` vazio e `LIVEKIT_LOCAL=true` no `.env`. Os amigos usam o **app desktop** com o endereço `http://100.x.y.z:666` (o IP Tailscale do seu PC).

O app desktop já libera microfone e câmera nesse endereço. Pelo navegador não funciona, porque o navegador exige HTTPS fora do localhost. Também é preciso liberar no firewall do Windows as portas 666, 7880 e 7881 (TCP) e 50000–50100 (UDP).

---

## Comandos úteis

| Comando | O que faz |
|---|---|
| `npm start` | Sobe o servidor (e o LiveKit local) |
| `npm run build` | Recompila a interface depois de mudar algo em `client/` |
| `npm run dev:client` | Interface em modo desenvolvimento (http://localhost:5173, recarrega sozinha). Deixe o `npm start` rodando junto |
| `npm run create-user -- nome senha` | Cria uma conta pelo terminal |
| `npm run reset-password -- nome novaSenha` | Redefine a senha de alguém que esqueceu |
| `npm run desktop` | Abre o app desktop em modo desenvolvimento |
| `npm run desktop:dist` | Gera o instalador e o .exe portátil em `desktop/dist/` |
| `npm run server:dist` | Compila a interface e gera o painel e o núcleo Concord Server (Windows x64) |
| `npm run dist` | Gera o executável do servidor e o instalador/portátil do cliente |

## Configuração (`.env`)

| Variável | Para que serve |
|---|---|
| `PORT` | Porta do site (padrão 666) |
| `INVITE_CODE` | Código exigido para criar conta. Vazio = qualquer um com o link cria conta |
| `LIVEKIT_URL` | Endereço do LiveKit para os navegadores. Vazio = `ws://<host do site>:7880` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Credenciais do LiveKit |
| `LIVEKIT_LOCAL` | `true` = o `npm start` sobe o LiveKit da pasta `livekit/` |

Depois de mudar as chaves do LiveKit local, rode `node scripts/setup.mjs` para atualizar o `livekit/livekit.yaml`.

## Áudio da tela sem eco

Ao compartilhar a tela com áudio, o Concord envia **todo o som do computador, menos o do próprio aplicativo**. A voz dos amigos fica de fora, então ninguém se ouve de volta.

- **App desktop**: usa o `desktop/native/minicord-audio.exe`, um capturador pequeno em C++. Ele usa a API de *Process Loopback* do Windows no modo "excluir processo", a mesma técnica do Discord. Funciona no Windows 11 e nas versões recentes do Windows 10. Se o Windows não suportar, o Concord avisa e compartilha só o vídeo, sem nunca mandar áudio com eco.
- **Navegador (Chrome/Edge)**: o Concord pede ao navegador para excluir o próprio som (`restrictOwnAudio`). O áudio só vai se você escolher "Tela inteira" e marcar "Compartilhar áudio do sistema" na janela do navegador.

O `minicord-audio.exe` já vem compilado. Para recompilar depois de mexer no `.cpp` (precisa do Visual Studio Build Tools com C++), rode `npm run build:native --prefix desktop`.

## Limitações conhecidas

- **Push-to-talk** e **envio de arquivos** ainda não existem. Imagens aparecem quando você cola um link de imagem.
- O app desktop não é assinado digitalmente, então o Windows SmartScreen pode avisar na primeira execução ("Mais informações → Executar assim mesmo").

## Backup

Com `npm start`, tudo (contas e mensagens) fica em `data/minicord.db`. No servidor executável, o banco fica em `%LOCALAPPDATA%\Minicord Server\data\minicord.db`. Para fazer backup, copie o arquivo com o servidor parado.
