# Protocolo H2H (Harness-to-Harness) by Jair Lima

Protocolo para que um harness de codificação por IA (Claude Code, Codex CLI, Gemini CLI, Antigravity/agy, Grok CLI, entre outros) delegue tarefas a outro harness diretamente na máquina local, tratando cada um como caixa-preta, sem orquestrador externo.

## O que há aqui

| Arquivo | Conteúdo |
|---|---|
| `SPEC.md` | Especificação do protocolo: motivação, diferenças em relação ao A2A, manifestos por harness, níveis de delegação, casos testados e limitações. |
| `ARTIGO_H2H_REVISADO_PUBLICACAO*.md/.pdf/.docx` | Artigo em português e em inglês (`_EN`). |
| `mailbox-mcp/` | Implementação de referência do canal assíncrono: servidor MCP de caixa de mensagens compartilhada entre harnesses. |

## Mailbox MCP

Ferramentas expostas: `enviar_mensagem`, `listar_mensagens`, `ler_mensagem` e `responder_mensagem`. As mensagens ficam em `mailbox-mcp/mailbox.json`, criado na primeira execução e ignorado pelo Git.

```bash
cd mailbox-mcp
npm install
node server.js
```

Registro no Claude Code (ajuste o caminho):

```bash
claude mcp add -s user h2h-mailbox -- node "/caminho/para/mailbox-mcp/server.js"
```

## Estado

Especificação em evolução (versão 0.1) com implementação de referência do canal assíncrono. Os casos de uso descritos foram testados por quem escreveu o protocolo em um ambiente Windows, e as versões dos CLIs mudam com frequência. Confira os comandos de cada harness antes de depender deles.

## Licença

MIT, veja `LICENSE`.
