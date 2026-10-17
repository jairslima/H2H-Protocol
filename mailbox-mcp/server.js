#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(DIR, "mailbox.json");

function loadMailbox() {
  if (!fs.existsSync(DB_PATH)) return { mensagens: [] };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { mensagens: [] };
  }
}

// Escrita atômica (arquivo temporário + rename) para reduzir risco de
// corrupção se dois processos (agy e claude) gravarem quase ao mesmo tempo.
// Não resolve 100% uma corrida real entre dois writes simultâneos (o mailbox
// é de uso pessoal e baixo volume, não foi projetado para concorrência pesada).
function saveMailbox(data) {
  const tmp = DB_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, DB_PATH);
}

const server = new McpServer({
  name: "h2h-mailbox",
  version: "1.0.0",
});

server.registerTool(
  "enviar_mensagem",
  {
    title: "Enviar mensagem H2H",
    description:
      "Envia uma mensagem para a caixa de entrada compartilhada do Protocolo H2H. " +
      "Use sempre uma tarefa real e concreta (nunca um comando isolado tipo 'responda apenas X'), " +
      "e preencha prova_contexto com o caminho absoluto de um arquivo real e verificável em disco " +
      "que documenta este protocolo (ex: SPEC.md ou PROJECT.md do projeto H2H) — isso permite que " +
      "quem ler a mensagem confirme por conta própria a legitimidade dela, em vez de confiar numa alegação.",
    inputSchema: {
      origem: z.enum(["agy", "codex", "gemini", "copilot", "claude", "outro"]),
      tarefa: z.string().min(10, "descreva a tarefa real, não um comando isolado"),
      contexto: z.string().min(10, "explique de onde essa tarefa veio (projeto, conversa, necessidade real)"),
      prova_contexto: z
        .string()
        .describe("caminho absoluto de um arquivo real que documenta o protocolo H2H"),
      diretorio: z.string().describe("caminho absoluto do projeto relevante à tarefa"),
    },
  },
  async ({ origem, tarefa, contexto, prova_contexto, diretorio }) => {
    const db = loadMailbox();
    const msg = {
      id: crypto.randomUUID(),
      origem,
      tarefa,
      contexto,
      prova_contexto,
      diretorio,
      timestamp: new Date().toISOString(),
      status: "pendente",
      resposta: null,
      resposta_timestamp: null,
    };
    db.mensagens.push(msg);
    saveMailbox(db);
    return {
      content: [
        { type: "text", text: `Mensagem registrada com id ${msg.id}, status pendente.` },
      ],
    };
  }
);

server.registerTool(
  "listar_mensagens",
  {
    title: "Listar mensagens H2H",
    description: "Lista mensagens da caixa H2H, opcionalmente filtradas por status.",
    inputSchema: {
      status: z.enum(["pendente", "lido", "respondido", "todas"]).default("pendente"),
    },
  },
  async ({ status }) => {
    const db = loadMailbox();
    const filtradas =
      status === "todas" ? db.mensagens : db.mensagens.filter((m) => m.status === status);
    return {
      content: [{ type: "text", text: JSON.stringify(filtradas, null, 2) }],
    };
  }
);

server.registerTool(
  "ler_mensagem",
  {
    title: "Ler mensagem H2H",
    description: "Lê uma mensagem específica pelo id e marca como lida.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const db = loadMailbox();
    const msg = db.mensagens.find((m) => m.id === id);
    if (!msg) {
      return {
        content: [{ type: "text", text: `Nenhuma mensagem encontrada com id ${id}.` }],
        isError: true,
      };
    }
    if (msg.status === "pendente") msg.status = "lido";
    saveMailbox(db);
    return { content: [{ type: "text", text: JSON.stringify(msg, null, 2) }] };
  }
);

server.registerTool(
  "responder_mensagem",
  {
    title: "Responder mensagem H2H",
    description: "Registra uma resposta para uma mensagem existente, pelo id.",
    inputSchema: { id: z.string(), resposta: z.string() },
  },
  async ({ id, resposta }) => {
    const db = loadMailbox();
    const msg = db.mensagens.find((m) => m.id === id);
    if (!msg) {
      return {
        content: [{ type: "text", text: `Nenhuma mensagem encontrada com id ${id}.` }],
        isError: true,
      };
    }
    msg.status = "respondido";
    msg.resposta = resposta;
    msg.resposta_timestamp = new Date().toISOString();
    saveMailbox(db);
    return { content: [{ type: "text", text: `Resposta registrada para a mensagem ${id}.` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
