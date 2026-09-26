# Discord Local

Chat, call de voz e transmissão de tela **privados**, entre amigos, sem depender de
nenhum serviço na nuvem. Um de vocês é o **host** (o servidor roda dentro do app
dele) e os outros se conectam pela VPN que vocês já usam: Tailscale, ZeroTier,
Hamachi, Radmin VPN etc.

- Amigos, mensagens diretas e grupos
- Call de voz (2–3 pessoas) com mudo, ensurdecer e indicador de quem está falando
- Transmissão de tela até 1080p 60fps (no Windows, com o áudio do PC)
- **Local-first:** o histórico fica no computador de cada um e dá pra ler offline.
  O host só guarda uma mensagem até ela ser entregue.
- **Atualiza sozinho** pelas Releases do GitHub (aviso na lateral + ⚙ Configurações → Atualizações)

Linux e Windows.

---

## Como usar

### 1. O host (quem vai hospedar)

1. Instale e ligue uma VPN "de rede local virtual" e coloque os amigos na mesma rede:
   - **Tailscale** (recomendado): [tailscale.com](https://tailscale.com). Convide os
     amigos para a sua tailnet ou compartilhe a sua máquina com eles.
   - **ZeroTier / Hamachi / Radmin VPN** também funcionam: basta todos estarem na mesma rede.
2. Baixe o instalador na página de [**Releases**](https://github.com/lukeprograming/discord-local/releases/latest):
   - Windows: `Discord-Local-x.y.z-win.exe`
   - Linux: `Discord-Local-x.y.z-linux.AppImage` (dê permissão de execução: `chmod +x`)
3. Abra o app e escolha **Ser o host**:
   - dê um nome ao servidor;
   - escolha o IP da sua VPN na lista (o app detecta Tailscale, ZeroTier e Hamachi);
   - crie a sua conta. A primeira conta do servidor é a do administrador.
4. Clique em **▶ Iniciar sessão online**. Com Tailscale, o app liga a VPN sozinho.
   Os amigos só conseguem conectar enquanto a sessão estiver online.

### 2. Convidar amigos

Em **⚙ Configurações → Convidar amigos**, clique em **Instalador Windows** ou
**Instalador Linux**. O app gera, na sua pasta de Downloads, um instalador que
**já vem com o seu endereço e um convite**. Mande esse arquivo pro seu amigo.

> O app baixa sozinho o instalador base da página de Releases (ou usa um que já
> esteja em Downloads) e só pergunta onde salvar.

⚠️ Esse arquivo funciona como uma chave do seu servidor: qualquer pessoa com ele
(e acesso à sua VPN) pode criar uma conta. Mande só pra quem você quer.

### 3. O amigo (conectado)

1. Entre na VPN do host.
2. Instale o arquivo que o host mandou.
3. Abra, escolha usuário e senha e pronto: não precisa digitar endereço nem código.

Sem o instalador do host, também dá: instale a versão limpa, escolha **Conectar em
um host** e informe o endereço (`http://IP-DO-HOST:47200`) e um código de convite
(o host gera em **+ amigo → Gerar código de convite**).

---

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "host não encontrado" | O host precisa clicar em **Iniciar sessão online**, e os dois precisam estar com a VPN ligada |
| Linux: "Sem permissão para ligar o Tailscale" | Rode uma vez: `sudo tailscale set --operator=$USER` |
| Call conecta mas não tem som | Confira o microfone em **⚙ Configurações** e, no Windows, se o firewall permitiu o app nas redes privadas |
| Windows: "O Windows protegeu o computador" | O app não é assinado: clique em **Mais informações → Executar assim mesmo** |
| Transmissão de tela no Linux não abre o seletor | Instale `xdg-desktop-portal` + o portal do seu desktop (`-kde` ou `-gnome`) |

Seus dados ficam em:
- Linux: `~/.config/Discord Local/`
- Windows: `%APPDATA%\Discord Local\`

Pra fazer backup, copie essa pasta (a subpasta `servidor/` é o banco do host).

---

## Desenvolvimento

```bash
cd desktop
npm install
npm start             # compila e abre o app
npm run dist          # gera AppImage + instalador Windows em desktop/release/
npx electron . --profile=teste2   # segunda instância com dados separados
```

O servidor também roda sozinho, sem o app: `cd server && npm install && node src/index.ts`
(escuta no IP do Tailscale; `HOST`, `PORT` e `DATA_DIR` mudam isso).

Arquitetura: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

### Publicar uma versão nova

1. Suba a versão em `desktop/package.json` (ex.: `0.2.1`).
2. `cd desktop && npm run dist`
3. Crie a release `v0.2.1` com **todos** estes arquivos de `desktop/release/`
   (os `.yml` e `.blockmap` são o que o atualizador lê):
   ```bash
   gh release create v0.2.1 --title "v0.2.1" --notes "o que mudou" \
     release/Discord-Local-0.2.1-win.exe release/Discord-Local-0.2.1-win.exe.blockmap release/latest.yml \
     release/Discord-Local-0.2.1-linux.AppImage release/latest-linux.yml
   ```
Os apps instalados avisam em até 4 horas (ou na hora, em **Verificar agora**).
