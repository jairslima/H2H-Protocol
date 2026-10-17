# Protocolo H2H by Jair Lima

## Descrição
Especificação, artigo e implementação de referência (Mailbox MCP) do protocolo Harness-to-Harness.

## Stack
Markdown (especificação e artigo); Node.js com `@modelcontextprotocol/sdk` e `zod` (`mailbox-mcp`).

## Estrutura
- `SPEC.md`: especificação.
- `ARTIGO_H2H_REVISADO_PUBLICACAO*`: artigo PT/EN em md, pdf e docx.
- `mailbox-mcp/`: servidor MCP (`server.js`).

## Comandos
`cd mailbox-mcp && npm install && node server.js`

## Decisões
- O canal assíncrono usa um arquivo JSON local (`mailbox.json`), nunca versionado.
- Esta é a cópia pública. O repositório privado de origem guarda anotações de livro e histórico de trabalho.

## Estado e próximos passos
Especificação 0.1 e Mailbox MCP funcionais. Próximo: ampliar o suporte a outros harnesses e publicar o artigo.

## Problemas conhecidos
Os testes de interoperabilidade foram feitos apenas em Windows.
