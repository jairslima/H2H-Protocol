# Protocolo H2H (Harness-to-Harness) — by Jair Lima

**Versão:** 0.1 (rascunho inicial)
**Autor:** Jair Lima
**Status:** conceito em desenvolvimento, não implementado, não publicado

## 1. Motivação

Harnesses de codificação (Claude Code CLI, Codex CLI, Gemini CLI, Antigravity/agy CLI) são produtos fechados, cada um casado a um LLM (ou família de LLMs) específico. Trocar o LLM por dentro de um harness que não foi desenhado pra ele não é viável sem gambiarra (proxy de API, etc.). Ao mesmo tempo, harnesses diferentes têm pontos fortes diferentes: um pode ter melhor ergonomia de continuidade de projeto e economia de contexto, outro pode estar acoplado ao LLM de raciocínio mais forte do momento para tarefas pontuais e pesadas.

O caso concreto que originou este protocolo: usar o Claude Code CLI como orquestrador principal de um projeto (memória, continuidade, ergonomia), delegando tarefas específicas de alta exigência de raciocínio para o Codex CLI quando este estiver rodando o LLM mais forte disponível para programação (ex: GPT-5.6), trazendo o resultado de volta para o Claude Code continuar. Hoje isso já é possível manualmente (o usuário pede explicitamente "peça pro Codex fazer X"). O H2H formaliza isso como **protocolo de roteamento entre harnesses**, com o objetivo de que a decisão de delegar deixe de depender de pedido explícito a cada vez e passe a ser guiada por política (capacidade da tarefa, custo/orçamento de tokens, disponibilidade).

**Nuance descoberta em 2026-07-26:** nem todo harness está "casado" a um único provedor. O Antigravity CLI (`agy`) e o OpenCode já são multi-provider por dentro (o `agy`, inclusive, roda Claude Opus 4.6 e Sonnet 4.6 diretamente, além de Gemini e GPT-OSS, via assinatura Google AI Pro). Isso não invalida o H2H, mas muda o cálculo de roteamento: às vezes a resposta certa não é "delegar a outro harness pra acessar outro LLM", e sim "usar um harness que já é multi-modelo por conta própria". O H2H continua necessário para os casos em que o harness atual não é multi-modelo (ex: Claude Code só roda Claude) ou quando a ergonomia/ferramentas específicas de outro harness (não só o LLM) são o motivo da delegação.

## 2. Por que não é A2A

Pesquisa (ver `memory/project_pendencias_delegacao_cli.md` e a discussão que originou este documento) mostrou que:

- **A2A (Agent2Agent, Linux Foundation/Google)** é um protocolo de rede, com `AgentCard` para descoberta, JSON-RPC sobre HTTP(S)/SSE, e modelo de tarefa/mensagem/artefato. Pressupõe agentes potencialmente remotos, multi-tenant, multi-usuário.
- **H2H**, como definido aqui, é **local, síncrono, por subprocesso**: um harness completo (processo, sandbox e contexto próprios) invoca outro harness completo na mesma máquina via linha de comando, sem rede, sem autenticação entre partes (a autenticação de cada harness com seu respectivo provedor de LLM já existe e é interna a cada um).
- A literatura de "harness engineering" (arXiv 2025-2026: AI Harness Engineering, Harness Handbook, HarnessX, The Harness Effect) estuda a arquitetura **interna** de um harness, não a composição **entre** harnesses independentes sem orquestrador externo. Ferramentas de mercado (Warp multi-harness, `majiayu000/harness`) resolvem composição via **control plane externo**, não via decisão do próprio harness chamador.
- Não existe, até a pesquisa realizada (2026-07-26), um protocolo nomeado para exatamente este caso: harness decidindo por si, sem orquestrador externo e sem rede, invocar outro harness como caixa-preta via CLI.

**Achado adicional (2026-07-26): o ACP (Agent Client Protocol).** Existe um padrão real, aberto e já adotado (Zed, desde ago/2025; JetBrains, Google, GitHub e 25+ agentes até jan/2026; registro público em zed.dev/acp), que padroniza comunicação via JSON-RPC 2.0 sobre stdin/stdout — comparável ao LSP, mas para agentes de código. Dois harnesses testados nesta pesquisa já falam ACP como servidor: `copilot --acp` e `opencode acp`. Porém, por design, o ACP é estritamente **editor↔agente** (o editor é sempre o cliente, o agente é sempre o servidor) — a própria especificação não aborda delegação agente↔agente, aninhamento, nem proteção contra recursão entre agentes. Ou seja: o ACP resolve a camada de transporte estruturado para quem já fala ACP, mas não resolve o problema central do H2H (um harness decidir, por conta própria, delegar a outro harness como par). **Implicação prática para v0.2:** o roteador de referência do H2H pode usar ACP como transporte para os harnesses que já o suportam (Copilot, OpenCode), em vez de reinventar parsing de CLI, mantendo o fallback de flags nativas para os que não suportam ACP ainda (Codex, Gemini, Claude Code, Antigravity/agy, nenhum deles expôs `--acp` até esta pesquisa).

## 3. Escopo da v0.1

**Dentro do escopo:**
- Máquina única (localhost), todos os harnesses já instalados e autenticados no mesmo usuário do sistema operacional.
- Invocação síncrona via subprocesso/CLI (não daemon, não servidor).
- Profundidade de delegação máxima = 1 (harness A delega a B; B não pode delegar de volta a A nem a um terceiro C dentro da mesma tarefa — ver seção 7).
- Harnesses cobertos nesta versão: Claude Code CLI (`claude`), Codex CLI (`codex`), Gemini CLI (`gemini`), Antigravity CLI (`agy`).

**Fora do escopo (v0.1):**
- Delegação em rede/remota (isso já é o espaço do A2A).
- Múltiplos saltos de delegação (A→B→C).
- Múltiplos usuários/autenticação cruzada.
- Delegação paralela (fan-out para vários harnesses simultaneamente) — fica para v0.2.

## 4. Terminologia

| Termo | Definição |
|---|---|
| **Harness** | Produto completo e opaco que executa um agente sobre um LLM: inclui runtime, sandbox, permissões, ferramentas e CLI própria. Ex: Claude Code, Codex CLI. |
| **Harness chamador (caller)** | O harness que decide delegar uma tarefa. |
| **Harness chamado (callee)** | O harness que recebe e executa a tarefa delegada, como caixa-preta. |
| **Manifesto de harness** | Descrição de capacidades e convenções de invocação de um harness (seção 5). |
| **Nível de autonomia H2H** | Vocabulário comum (0-3) que abstrai os diferentes nomes de modo de permissão de cada harness (seção 6). |
| **Descritor de tarefa** | Estrutura mínima com o que está sendo delegado (seção 7). |

## 5. Manifesto de harness (capacidades)

Cada harness suportado precisa de um manifesto descrevendo como invocá-lo. Rascunho de formato (YAML), com os 4 harnesses já testados nesta máquina:

```yaml
claude:
  binario: claude
  modo_headless: ["-p", "<tarefa>"]
  formato_saida: ["--output-format", "json"]   # também suporta text, stream-json
  diretorio_trabalho: usa cwd do processo (sem flag -C); precisa `cd` antes
  modelos: ["sonnet 5 (padrão da conta do autor)", "opus 5", "haiku 4.5", "fable 5 (requer créditos de uso separados da cota do plano Pro, confirmado por print do Claude Code Desktop em 2026-07-27)"]  # só família Claude — CLI e Desktop compartilham a mesma conta/modelos, não são integrações separadas como Codex CLI vs Codex Desktop
  niveis_autonomia_nativos:
    0: "--permission-mode plan"
    1: "--permission-mode acceptEdits"
    2: "--permission-mode auto"
    3: "--dangerously-skip-permissions"
  restricoes_conhecidas:
    - "não pode se autoinvocar a partir de dentro de uma sessão Claude Code já ativa — uma sessão `claude` tentando rodar `claude -p` via sua própria ferramenta de Bash é bloqueada (guarda antirrecursão, observado em 2026-07-26). ATUALIZADO 2026-09-01: essa guarda é específica a autoinvocação, não a chamada externa em geral — confirmado que um processo `claude -p ... --dangerously-skip-permissions` disparado por um harness terceiro totalmente independente (agy, como subprocesso OS-level, não de dentro de uma sessão Claude Code) roda normalmente (exit code 0, ~59s). Ver Seção 8."
    - "camada de segurança separada e não-bypassável por flag: mesmo com `--dangerously-skip-permissions`, uma instância headless recém-iniciada aplica julgamento próprio de conteúdo — uma instrução crua sem contexto de tarefa real, com formato clássico de prompt injection (alega autoridade externa + pede resposta fixa/'senha'), é corretamente tratada como suspeita e a sessão pede confirmação humana em vez de obedecer. Não é bug nem limitação de transporte, é comportamento de segurança do próprio modelo — mensagens H2H genuínas devem carregar contexto de tarefa real e verificável, não um comando isolado. Ver Seção 8."

codex:
  binario: codex   # v0.157.1 em 2026-09-29 (anteriormente v0.145.0 em 2026-07-26)
  modo_headless: ["exec", "<tarefa>"]
  diretorio_trabalho: ["-C", "<dir>"]
  modelos: ["gpt-6-sol (modelo de raciocínio de ponta ativo e confirmado em 2026-09-29)", "gpt-5.6-sol", "gpt-5.5 high"]
  observacao_importante: "logado via 'ChatGPT account' (`codex login status`); em 2026-09-29 o modelo padrão de execução headless foi atualizado para gpt-6-sol; no Windows/pwsh, fechar stdin via `< nul` para evitar espera de pipe aberto."
  niveis_autonomia_nativos:
    0: "-s read-only"
    1: "-s workspace-write"   # ATUALIZADO 2026-07-27: ver nota de quebra de compatibilidade abaixo
    2: "-s workspace-write"   # no modo `exec`, não existe mais distinção 1 vs 2 (ver nota)
    3: "--dangerously-bypass-approvals-and-sandbox"

  nota_quebra_compatibilidade: "2026-07-27: uma versão mais nova do Codex CLI removeu inteiramente o flag `-a`/`--ask-for-approval` de `codex exec --help` (`error: unexpected argument '-a' found`). O motivo: o modo `exec` já roda não-interativo por padrão (sem TTY pra aprovar nada), então `-s workspace-write` sozinho já dá autonomia de escrita total na pasta indicada, sem prompt de aprovação — a distinção de níveis 1/2 que existia via `-a on-request`/`-a never` deixou de existir no `exec`. Contribuição verificada e trazida de outra sessão Claude Code do mesmo usuário (achado original registrado em `memory/feedback_delegacao_codex_a2a.md`), confirmada de forma independente aqui rodando `codex exec --help` nesta sessão."
  observacoes:
    - "requer --skip-git-repo-check fora de repositório git confiável"
    - "lê instruções globais em ~/.codex/AGENTS.md"
    - "CASO DE ESTUDO PARA O PROTOCOLO: esta quebra de compatibilidade é um exemplo real do risco que os manifestos de harness do H2H precisam mitigar — CLIs de terceiros mudam flags sem aviso prévio entre versões. Ver seção 'Trabalhos futuros' sobre versionamento/healthcheck de manifesto."
    - "PADRÃO DE COMPOSIÇÃO HÍBRIDA (2026-07-27, validado em produção — capa de livro real 1600x2560 300 DPI): quando a tarefa delegada via H2H precisa de texto preciso numa imagem (títulos, acentos, idiomas não-ingleses), pedir ao Codex pra gerar só a ARTE via `image_gen`/skill imagegen (sem texto embutido) e depois compor a tipografia com um script determinístico (o Codex usou PowerShell + System.Drawing do .NET) por cima. Evita o problema clássico de modelos de difusão distorcerem texto/diacríticos. O script de composição vira artefato reprodutível do projeto (ex: `render-capa.ps1`), permitindo regenerar a capa sem nova chamada ao modelo de imagem."
    - "DEPENDÊNCIA FRÁGIA NÃO DOCUMENTADA (2026-07-28): a skill `imagegen` do Codex depende implicitamente de `ImageMagick` (`magick`) pra um passo de redimensionamento — se não estiver instalado, a geração de capa pode falhar SILENCIOSAMENTE em pipelines automatizados (sem erro visível num wrapper que resume a saída). Em produção, o próprio Codex detectou a ausência e contornou sozinho usando `System.Drawing` via PowerShell (sem dependência externa) — mas isso não é garantido, é resiliência observada, não comportamento documentado/contratual da skill. Verificar se `magick` está instalado, ou preferir explicitamente o caminho PowerShell/.NET, antes de depender dessa skill em produção."
    - "TÉCNICA DE DIAGNÓSTICO DE FALHA SILENCIOSA: quando um script wrapper que invoca este harness falha sem erro claro, invocar o harness diretamente (fora do wrapper) com captura completa de stdout/stderr (sem truncar/resumir) revela a causa raiz que o wrapper escondia. Usar monitoramento por eventos em tempo real em vez de polling com sleep para tarefas longas (ex: geração de imagem)."

gemini:
  binario: gemini
  modo_headless: ["-p", "<tarefa>"]
  diretorio_trabalho: usa cwd do processo (sem flag -C); precisa `cd` antes
  modelos: ["gemini-3.1-pro (cota esgotada nesta conta)", "gemini-2.5-flash (funcional)"]
  niveis_autonomia_nativos:
    0: "--approval-mode plan"
    1: "--approval-mode auto_edit"
    2: "--approval-mode auto_edit"
    3: "--approval-mode yolo"
  observacoes:
    - "--skip-trust necessário fora de workspace confiável"

agy:
  binario: agy   # Antigravity CLI — MULTI-PROVIDER real, não só Gemini
  modo_headless: ["-p", "<tarefa>"]
  diretorio_trabalho: usa cwd do processo; precisa `cd` antes
  modelos: ["Gemini 3.6/3.5/3.1 Flash/Pro", "Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)"]  # confirmado por print do usuário em 2026-07-26, conta "Google AI Pro"
  arquivo_instrucoes_global: "~/.gemini/GEMINI.md"   # COMPARTILHADO com o Gemini CLI (mesma conta/pasta ~/.gemini) — editar aqui afeta os dois
  niveis_autonomia_nativos:
    0: "--mode plan"
    1: "--mode accept-edits"
    2: "--mode accept-edits"   # não cobre execução de comando
    3: "--dangerously-skip-permissions"
  restricoes_conhecidas:
    - "nível 3 bloqueado nesta máquina até liberação manual em settings.json (ver PROJECT.md)"
  observacoes:
    - "Achado 2026-07-26: agy roda Claude Opus 4.6/Sonnet 4.6 DIRETAMENTE (não precisa de H2H pra acessar Claude a partir dele) — isso muda a lógica de roteamento: delegar ao agy já dá acesso a Claude E Gemini E GPT-OSS num único harness, parecido com o OpenCode mas com modelos de ponta de verdade, não só gratuitos/nicho"

copilot:
  binario: copilot   # GitHub Copilot CLI — equivalente headless do "harness VS Code"
  modo_headless: ["-p", "<tarefa>"]
  diretorio_trabalho: ["-C", "<dir>"]
  formato_saida: desconhecido ainda (verificar --format ou equivalente)
  modelos: ["gpt-5.4 (confirmado no --help)", "modelos Claude via assinatura Copilot (não confirmado ainda)"]
  niveis_autonomia_nativos:
    0: "(padrão, pede confirmação por ferramenta)"
    3: "--allow-all"
  observacoes:
    - "suporta --acp (fala Agent Client Protocol nativamente como servidor)"
    - "descoberto em 2026-07-26, ainda não testado end-to-end (nem modo texto simples)"

opencode:
  binario: opencode
  modo_headless: ["run", "<mensagem>"]
  diretorio_trabalho: ["--dir", "<dir>"]
  formato_saida: ["--format", "json"]  # também "default"
  modelos: multi-provider nativo, formato "provider/model" (--model)
  niveis_autonomia_nativos: desconhecido ainda (nenhuma flag óbvia tipo --allow-all no --help; investigar config/permissões)
  observacoes:
    - "suporta 'opencode acp' (roda como servidor ACP)"
    - "uso pretendido pelo autor: testar LLMs 'fora das bigs' (modelos alternativos/nicho), NÃO é o canal usado para GPT-5.6/Claude Opus — por isso só o provedor gratuito padrão (opencode/big-pickle) apareceu configurado; testado com sucesso em modo texto simples em 2026-07-26"

copilot:
  binario: copilot   # GitHub Copilot CLI — equivalente headless do "harness VS Code"
  modo_headless: ["-p", "<tarefa>"]
  diretorio_trabalho: ["-C", "<dir>"]
  modelos_completos: # confirmado por print oficial do menu /model em 2026-07-27
    gpt: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5-mini"]
    claude: ["claude-sonnet-5", "claude-sonnet-4.6", "claude-sonnet-4.5", "claude-haiku-4.5", "claude-fable-5", "claude-opus-5", "claude-opus-4.8", "claude-opus-4.8-fast", "claude-opus-4.7", "claude-opus-4.6", "claude-opus-4.5"]
    outros: ["gemini-3.1-pro-preview", "gemini-3.6-flash", "gemini-3.5-flash", "kimi-k2.7-code"]
  restricao_de_plano: "conta do autor está no Copilot FREE plan — só o modo 'Auto' é utilizável (escolhe automaticamente, na prática caiu em gpt-5-mini no teste); qualquer modelo específico da lista acima (incluindo gpt-5.6-sol) retorna 'Error: Model ... is not available' / 'Upgrade your plan' até fazer upgrade em github.com/settings/copilot — confirmado por print E por teste via CLI (`--model gpt-5.6-sol` falhou)"
  niveis_autonomia_nativos:
    0: "(padrão, pede confirmação por ferramenta)"
    3: "--allow-all-tools"
  observacoes:
    - "suporta --acp (fala Agent Client Protocol nativamente como servidor)"
    - "TESTADO E VALIDADO em 2026-07-26: modo texto simples funcionou, e autonomia total (--allow-all-tools) criou e executou um arquivo sem nenhum bloqueio — melhor resultado entre todos os harnesses testados até agora"
    - "convenção salva em memory/feedback_delegacao_copilot_a2a.md; tentativa de gravar no CLAUDE.md global bloqueada pelo classificador (mesmo padrão do Gemini)"

cursor_agent:
  binario: cursor-agent   # CLI oficial de agente do Cursor — NÃO tem build nativo Windows, instalado via WSL (Ubuntu)
  modo_headless: ["-p", "<tarefa>"]
  diretorio_trabalho: ["--workspace", "<dir>"]   # ou `cd` antes, dentro do wrapper wsl
  modelos: ["Auto (roteador padrão, usado no teste)", "gpt-5", "sonnet-4-thinking", "claude-opus-4-8[context=1m,effort=high,fast=false] (confirmado no --help, aceita parâmetros)"]
  niveis_autonomia_nativos:
    0: "--mode plan"
    3: "--yolo (alias de --force)"
  requisito_adicional: "--trust obrigatório na primeira execução por diretório (ou --yolo/-f também cobre), senão retorna erro 'Workspace Trust Required' e recusa rodar"
  observacoes:
    - "instalado oficialmente via `curl https://cursor.com/install -fsS | bash` dentro do WSL Ubuntu em 2026-07-26 — NÃO usar forks de terceiros 'patcheados' para Windows nativo (ex: repos GitHub não-oficiais), risco de supply-chain, mesmo raciocínio que descartou o npm 'antigravity-cli' squatting"
    - "TESTADO E VALIDADO em 2026-07-27: autenticado via `cursor-agent login` (o usuário rodou pessoalmente, OAuth interativo), modo texto ok, autonomia total (--yolo) criou e executou hello_cursor.py com sucesso, verificado lendo o arquivo de volta — ÚLTIMO harness do projeto a ser validado, completando os 8"
    - "toda invocação precisa passar por `wsl -d Ubuntu -e bash -c '...'`"

cursor_editor:
  binario: cursor   # app gráfico (Anysphere.Cursor via winget) — NÃO é o agente headless, é só editor (abrir arquivo, diff, merge)
  modelos_gui: ["Auto", "MAX Mode", "Composer 2.5 Fast (padrão)", "Opus 4.8 High", "GPT-5.5 Medium", "Sonnet 4.6 Medium", "Codex 5.3 Medium", "Fable 5 High"]  # confirmado por print em 2026-07-27, painel "New Agent" do app
  restricao_de_plano: "conta do autor no app gráfico também está em plano Free ('Upgrade to a Pro account' visível) — mesmo padrão do Copilot Free; modelos premium podem estar limitados igual lá, não testado via GUI"
  observacoes:
    - "instalado via winget em 2026-07-26, mas não expõe modo headless/agente — não serve para H2H, só o cursor_agent (acima) serve"
    - "nota de nomenclatura: o app lista um modelo chamado 'Codex 5.3', diferente do produto 'Codex CLI' (OpenAI) que testamos — são coisas distintas com nome parecido, cuidado ao citar no livro/artigo para não confundir o leitor"
grok:
  binario: grok   # Grok Build (xAI/SpaceXAI), versão 1.0.46 (2765805b9442): TUI e modo headless; build Linux, instalado no WSL Ubuntu em ~/.local/bin/grok (sem build nativo Windows nesta máquina)
  modo_headless: ["-p", "<tarefa>"]   # prompt vazio retorna "Error: --single: prompt is empty"
  modelo: ["-m", "<chave de [model.X] do config.toml ou id do modelo>"]   # padrão grok-4.7 (via `grok login`, sessão Oidc)
  diretorio_trabalho: ["--cwd", "<dir>"]   # ou `cd` antes, dentro do wrapper wsl
  niveis_autonomia_nativos:
    0: "sem --always-approve, pede aprovação por ação (inadequado em -p headless)"
    3: "--always-approve (aprova todas as ferramentas); também há --allow/--deny <regra> para regras finas e permission_mode no config.toml"
  provedores_customizados:
    - "QUALQUER endpoint compatível com OpenAI Chat Completions, Responses ou Anthropic Messages, sem fork nem plugin, via ~/.grok/config.toml: seções [model.<nome>] com model, base_url (raiz, sem /chat/completions), api_backend (chat_completions|responses|messages), env_key (variável com a chave), context_window e name"
    - "ordem de resolução da credencial: api_key no config, depois a variável nomeada em env_key, depois a sessão `grok login`, depois XAI_API_KEY (doc oficial xai-org/grok-build, guia 11-custom-models)"
    - "CONFIGURADO E TESTADO em 2026-10-06 nesta máquina: [model.deepseek-pro] model=deepseek-v4-pro e [model.deepseek-flash] model=deepseek-flash (DeepSeek V4.1 Flash), base_url=https://api.deepseek.com, env_key=DEEPSEEK_API_KEY, api_backend=chat_completions, context_window=1048576. Os ids vieram de GET https://api.deepseek.com/models com a chave real, não de blog"
    - "PROVA DE ROTEAMENTO: com chave inválida de propósito, a chamada foi para https://api.deepseek.com/chat/completions e voltou 401; com a chave real respondeu. O log de --debug-file mostra `config model override applied ... base_url=https://api.deepseek.com`"
    - "PEGADINHA: o modelo responde 'sou o Grok, criado pela xAI' mesmo roteado para a DeepSeek, porque o Grok CLI injeta o próprio prompt de sistema. NÃO usar autodeclaração do modelo para saber qual LLM respondeu; usar o 401 de teste, o --debug-file ou o painel do provedor"
    - "a chave NÃO é gravada no config.toml (só o nome da variável). A chave fica em %USERPROFILE%\\.api_keys\\credentials.env; no WSL o ~/.bashrc a lê desse arquivo a cada shell; para chamadas a partir do Windows, exportar DEEPSEEK_API_KEY e WSLENV=DEEPSEEK_API_KEY antes do `wsl -e bash -lc`"
  ferramentas_de_midia:
    - "image_gen (imagem nova), image_edit (editar imagem existente) e reference_to_video (vídeo); skills embarcadas em ~/.grok/bundled/skills (imagine, game-assets, docx, pdf, pptx, design, review, resume-claude, resume-codex, resume-cursor, entre outras)"
    - "a skill `imagine` alerta que modelos de imagem erram texto exato e manda verificar lendo a imagem de volta, reconstruindo por código se necessário: relevante para capas de livro (ver a Seção 14). NÃO testado ainda: geração de capa pelo Grok"
  observacoes:
    - "interoperabilidade WSL e Windows: lê e escreve em /mnt/c/... e executa .exe do Windows por caminho /mnt/c (ex.: godot.exe), desde que os caminhos passados ao .exe sejam convertidos com `wslpath -w`. Validado em 2026-10-06 com Godot 4.7.2 (--headless --import e --check-only) e git.exe"
    - "TESTADO E VALIDADO em 2026-10-06: leu arquivo, criou arquivo e rodou comando externo; depois escreveu 3 capítulos de livro e 9 apêndices com validação real no Godot e reconstruiu um histórico Git com portão objetivo (git diff vazio). Ver a Seção 14"
    - "tempo observado por tarefa longa: capítulo de cerca de 4.000 palavras com validação no Godot, de 10 a 30 min; nove apêndices, cerca de 47 min"
    - "o classificador do modo automático do Claude Code BLOQUEOU a primeira tentativa de lançar `grok --always-approve` (motivo 'Create Unsafe Agents', mesmo padrão do `agy --dangerously-skip-permissions`); depois que o usuário pediu explicitamente para tentar de novo, a mesma chamada foi permitida. Tratar como ação que exige autorização expressa do usuário"
    - "custo e limite: as chamadas roteadas para a DeepSeek usam API pré-paga na conta DeepSeek do autor, que ele reabastece quando quiser; NÃO há limite de uso por assinatura nem janela de reset, diferente do Codex (limite de uso da conta ChatGPT, com horário de retorno) e do agy (erros 429/503). O único teto é o saldo da conta, e o volume gasto não foi medido"
    - "sem recursão: Claude Code chamando o Grok é permitido (produtos distintos); evitar o caminho inverso a partir do Grok"
```

## 6. Vocabulário comum de autonomia

| Nível H2H | Significado | Equivalente aproximado por harness |
|---|---|---|
| 0 | Somente leitura/planejamento, nenhuma escrita | plan / read-only |
| 1 | Edições de arquivo auto-aprovadas, comandos ainda pedem aprovação | acceptEdits / accept-edits / auto_edit |
| 2 | Edições e comandos dentro do workspace auto-aprovados, sem sair do sandbox do harness | auto / workspace-write (Codex CLI: desde 2026-07-27, `-s workspace-write` sozinho já é nível 2 no modo `exec`, o antigo `-a never` foi removido) |
| 3 | Autonomia total, bypass de todas as checagens de permissão | dangerously-skip-permissions / yolo / bypass-approvals-and-sandbox |

Nível 3 é o mais arriscado e, por design, cada harness (incluindo o próprio Claude Code) pode se recusar a conceder esse nível a si mesmo sem intervenção manual do usuário fora da sessão — isso é considerado **comportamento correto do H2H**, não uma falha a ser contornada (ver seção 8).

## 7. Descritor de tarefa (contrato de invocação)

Estrutura mínima que o harness chamador monta antes de delegar:

```yaml
tarefa: "texto em linguagem natural da tarefa a delegar"
harness_alvo: codex | gemini | agy | claude
diretorio: "caminho absoluto do projeto relevante"
nivel_autonomia: 0-3
modelo: "opcional, override do modelo padrão do harness alvo"
timeout_segundos: 300   # OBRIGATÓRIO IMPOR, não só documentar — ver caso de falha na Seção 6.2 do ARTIGO.md
profundidade_delegacao: 0   # incrementado a cada salto; ver seção 8
```

**Regra derivada de um caso de falha real (2026-07-28):** `timeout_segundos` não é um valor informativo, é um limite que o harness chamador **deve impor automaticamente** (matar o processo delegado ao expirar). Em um teste real, o Codex ficou mais de 15 minutos travado (provável tentativa de acesso à rede sem sair do sandbox padrão do `exec`) sem nenhum corte automático — só uma decisão humana observando a estagnação interrompeu o processo. Regra adicional derivada do mesmo caso: **antes de retomar uma tarefa após interromper um harness delegado, o chamador deve verificar explicitamente se os artefatos-alvo foram parcialmente modificados**, antes de prosseguir com sua própria implementação.

## 7.1. Descritor de tarefa para chamadas reversas (harness terceiro → Claude Code)

O Descritor de Tarefa da Seção 7 basta para o Claude Code delegar pra fora, porque ele mesmo monta o contrato. Para a direção inversa (agy/Codex/Gemini/Copilot → Claude), a Seção 8 itens 4-5 mostrou que isso não basta: uma instância `claude -p` recém-iniciada aplica julgamento de conteúdo próprio e recusa um comando cru sem prova de contexto real. O envelope abaixo existe especificamente pra passar por essa checagem de forma legítima, não pra contorná-la:

```yaml
protocolo: H2H-v0.1
origem: agy | codex | gemini | copilot   # harness chamador real
tarefa: "descrição concreta do trabalho, nunca um comando isolado tipo 'responda apenas X'"
contexto: "por que essa tarefa existe — de que projeto/conversa/necessidade real ela veio"
prova_contexto: "caminho absoluto de um arquivo real e verificável no disco que documenta este protocolo e autoriza a chamada, ex: <caminho absoluto>\\SPEC.md"
diretorio: "caminho absoluto do projeto relevante à tarefa"
timestamp: "ISO 8601"
```

**Regra de uso:** o campo `prova_contexto` não é uma alegação de autoridade (isso é exatamente o padrão que a checagem de conteúdo já rejeita corretamente), é um convite para o Claude Code VERIFICAR por conta própria, lendo o arquivo apontado, que o protocolo é real e documentado, antes de agir. Uma mensagem sem esse campo, ou com um comando de resposta fixa sem tarefa real por trás, deve continuar sendo tratada com a mesma suspeita de hoje — isso é o comportamento correto, não um bug a maquiar.

## 8. Guarda contra recursão e loop

Regras obrigatórias, não opcionais:

1. **Nenhum harness pode invocar a si mesmo.** Mesmo através de um manifesto tecnicamente correto, se `harness_alvo == harness_atual`, a invocação é recusada antes de tentar rodar o comando.
2. **`profundidade_delegacao` máxima = 1 na v0.1.** Um harness que recebe uma tarefa delegada (profundidade 1) não pode, dentro dessa mesma tarefa, delegar novamente a outro harness. Ele deve resolver a tarefa sozinho ou reportar falha ao chamador.
3. Isso está alinhado com o que já foi observado na prática: frameworks de agente removem a ferramenta de subagente das allowlists dos processos filhos justamente para impedir "infinite agentic loops" (achado na pesquisa, ver `arxiv 2607.01641`).
4. **ATUALIZAÇÃO 2026-09-01 — distinção confirmada entre autoinvocação e invocação externa:** o bloqueio de "Codex → Claude" registrado em 2026-07-26 (item 3 do histórico do projeto, ver `memory/project_pendencias_delegacao_cli.md`) foi testado de dentro de uma sessão Claude Code tentando gerar `claude` como processo filho de si mesma — isso é autoinvocação (regra 1 acima), e continua bloqueado por design. Teste novo e independente (agy, 2026-09-01): um processo `agy` totalmente externo, fora de qualquer sessão Claude Code, rodou `claude -p "..." --dangerously-skip-permissions` como subprocesso próprio — **executou normalmente (exit code 0, ~59s), sem bloqueio nenhum de permissão ou de sistema.** Conclusão: a guarda antirrecursão da regra 1 é sobre a *origem* da chamada (uma sessão Claude não pode gerar outra Claude a partir de si mesma), não sobre "quem" está do outro lado — harnesses de terceiros (agy, e provavelmente Codex/Gemini/Copilot da mesma forma, ainda não retestados individualmente) podem invocar `claude -p` livremente como processo OS-level independente.
5. **Camada de segurança separada, não relacionada a permissão de sistema:** mesmo passando pela regra 1 sem problema, a instância `claude -p` recém-iniciada aplicou julgamento de conteúdo próprio sobre o prompt recebido — um comando cru pedindo resposta fixa ("responda apenas: TESTE H2H RECEBIDO"), sem contexto de tarefa real, tem a forma clássica de um teste de prompt injection, e foi tratado como tal: a sessão recusou obedecer cegamente e pediu confirmação humana ("essa solicitação partiu de você mesmo, Jair?"). **Implicação de design pro protocolo H2H:** mensagens disparadas por outro harness pro Claude Code devem carregar contexto de tarefa real e verificável (referência a arquivo/projeto real, descrição de trabalho concreto), não um comando isolado estilo "responda X". Isso não é uma limitação a contornar com engenharia (ex. um mailbox MCP não elimina essa camada por si só, o mesmo julgamento de conteúdo se aplicaria a uma mensagem MCP igualmente vazia de contexto), é um comportamento de segurança correto do modelo que o design das mensagens precisa respeitar.

## 9. Soberania de permissão do harness chamado

O harness chamador **nunca** pode forçar o harness chamado a rodar em nível de autonomia acima do que o próprio harness chamado permite para si mesmo naquele momento (configurações locais, classificador de modo automático, etc.). Se o chamado recusar nível 3, o chamador deve degradar a tentativa (nível 2, reportar a limitação ao usuário) em vez de tentar contornar. Isso não é uma limitação do protocolo, é uma decisão de design: cada harness continua sendo dono da própria política de segurança.

## 10. Log de custo e atribuição

Toda delegação deve ser registrada (mínimo local, arquivo de log) com: harness chamador, harness chamado, resumo da tarefa, timestamp, tokens/custo se o harness chamado expuser essa informação na saída. Objetivo: permitir auditar quanto de cada assinatura/API foi gasto via delegação H2H, não só via uso direto.

## 11. Matriz de suporte atual (nesta máquina, 2026-07-26)

| Par | Direção | Status |
|---|---|---|
| Claude → Codex | funcional | nível 2 (workspace-write, sem aprovação) validado |
| Claude → Gemini | funcional | nível 3 (yolo), modelo fixado em gemini-2.5-flash por cota |
| Claude → Antigravity/agy | parcial | modo texto (nível 0) funcional; nível 3 pendente de permissão manual |
| Codex → Claude | não retestado desde a correção de escopo | bloqueio de 2026-07-26 era autoinvocação (Claude tentando gerar `claude` a partir de si mesma), não bloqueio geral — ver Seção 8, item 4. Codex especificamente ainda não retestou a chamada externa real. |
| **Antigravity/agy ↔ Claude (Subprocesso Direto e Mailbox MCP)** | **EM PRODUÇÃO REAL (2026-09-01 e 2026-09-29)** | Dois canais complementares validados em produção: (1) **Mailbox MCP** (assíncrono, mensageria estruturada com prova de contexto); (2) **Subprocesso direto** (`claude -p "..." --dangerously-skip-permissions`, síncrono, exit code 0 em ~25s), com Claude Code lendo arquivos locais e devolvendo relatório completo sem bloqueio de recursão. |
| **Antigravity/agy → Codex CLI** | **funcional, nível 2 (workspace-write, 2026-09-29)** | Invocado via subprocesso nativo com modelo de ponta `gpt-6-sol` em 8s (exit code 0), fechando stdin com `< nul` no Windows para evitar bloqueio de pipe. |
| Codex → Gemini/agy | não testado | próximo passo natural, mesma mecânica de Claude→Codex |
| Gemini → outros | não testado | — |
| Claude → Copilot CLI | **funcional, nível 3, mas modelo travado no Free** | testado em 2026-07-26: modo texto ok, `--allow-all-tools` criou/executou arquivo sem nenhum bloqueio; em 2026-07-27 confirmado que a conta é Copilot Free — só "Auto" (caiu em gpt-5-mini) funciona, `gpt-5.6-sol` e todos os Claude/outros modelos pedem upgrade de plano |
| Claude → OpenCode | funcional, nível 0 (uso restrito) | testado em 2026-07-26 com o provedor gratuito padrão; autor usa OpenCode especificamente para testar LLMs "fora das bigs", não para GPT-5.6/Claude Opus |
| Claude → Cursor Agent CLI (via WSL) | **funcional, nível 3 — ÚLTIMO harness validado (2026-07-27)** | usuário autenticou via `cursor-agent login`; testado modo texto e `--yolo` criando/executando `hello_cursor.py` com sucesso, verificado lendo o arquivo de volta. Exige `--trust` (ou `--yolo`) na primeira execução por diretório. Completa os 8 harnesses do projeto. |
| Cursor (app gráfico) | instalado, não é harness H2H | `Anysphere.Cursor` via winget; só abre editor, não tem modo agente headless — o `cursor_agent` (WSL) é quem importa pro H2H |
| **Claude → Grok CLI (via WSL)** | **funcional, nível 3 (`--always-approve`, 2026-10-06)** | testadas leitura, escrita e execução de `godot.exe` por interop; em produção real escreveu 3 capítulos e 9 apêndices do livro "Godot com Vibe Coding" e reconstruiu um histórico Git com verificação objetiva. Exige autorização expressa do usuário no modo automático (ver o manifesto) |
| **Grok CLI → DeepSeek (provedor customizado)** | **funcional (2026-10-06)** | `grok -m deepseek-pro` e `-m deepseek-flash`, endpoint compatível com OpenAI, sem fork. É o único harness do roster que aceita DeepSeek por configuração oficial; Gemini CLI, Antigravity e Cursor Agent CLI não aceitam (ver a Seção 14) |
| Grok CLI → imagem (`image_gen` e `image_edit`) | existe, não testado | ferramentas nativas do Grok Build; teste de capa pendente |
| VS Code (editor) | reinstalado | `Microsoft.VisualStudioCode` v1.129.0 via winget, funcional |
| Codex → Gemini/Copilot/agy (config) | **configurado e validado** | `~/.codex/AGENTS.md` atualizado com os 3 manifestos de delegação + guarda antirrecursão explícita ("nunca chamar `claude`); testado com `codex exec` pedindo resumo das instruções, resposta correta |
| **Claude → Codex: geração de imagem** | **CASO EMBLEMÁTICO — funcional** | 2026-07-27: pedimos ao Codex gerar uma imagem (maçã vermelha, fundo branco); ele usou sua skill interna `imagegen` (`gpt-image-2`), sem precisar de `OPENAI_API_KEY` do usuário, salvou o PNG (~1MB) no caminho pedido. Resolve a maior lacuna categórica do Claude Code (zero capacidade nativa de imagem) via H2H. Ver Seção 6.1 do `ARTIGO.md` e capítulo 7 do `LIVRO-NOTAS.md`. |
| **Claude → Codex: capa de livro em produção** | **funcional, padrão de composição híbrida** | capa real 1600×2560px/300 DPI gerada e verificada (`capa.png` + `render-capa.ps1`); Codex gerou só a arte via `image_gen` e compôs o texto/acentos com PowerShell+`System.Drawing` determinístico, evitando distorção de texto por IA. |
| **Claude → Codex: parecer editorial estruturado** | **funcional, caso de delegação de trabalho intelectual** | Codex atuou como "editor profissional" avaliando manuscrito real do usuário; entregou parecer de ~23KB com achados auto-classificados por severidade (`CORREÇÃO SIMPLES` vs `MUDANÇA ESTRUTURAL/EDITORIAL FORTE`), permitindo triagem automática. Ver Seção 6.0 do `ARTIGO.md`. |
| **Debug de bug Godot (multi-monitor): Codex → agy → Copilot** | **CASO MAIS RICO DO PROJETO — resolvido na 3ª tentativa** | 2026-07-28, mesmo bug real (tela preta no monitor secundário), três harnesses em sequência: Codex travou por timeout (sem corte automático); agy deu diagnóstico plausível mas incorreto (SubViewport por câmera, não resolveu); Copilot identificou a causa raiz real (Vulkan falhando ao criar 2ª swapchain com 2 Windows nativas) e a correção (unificar numa única janela) **funcionou, confirmado pelo usuário**. Ver Seção 6.2 do `ARTIGO.md` para o caso completo. |
| **Claude → Codex: 2ª capa de livro (domínio diferente)** | **funcional após diagnóstico de falha silenciosa** | 2026-07-28, livro "Edição Genética por CRISPR" (Teologia, domínio diferente do RISC-V): geração automática via script wrapper falhou silenciosamente (dependência não documentada de `ImageMagick` ausente); invocando o Codex diretamente com stdout/stderr completo (via monitoramento de eventos, não polling), revelou a causa e o próprio Codex contornou sozinho usando PowerShell/`System.Drawing`. Capa gerada com sucesso (1600×2560px, 300 DPI). Confirma o padrão de composição híbrida em 2º domínio e revela técnica de diagnóstico de falha silenciosa reaproveitável. |
| **Claude → Codex: correção de citações com regra anti-fabricação** | **funcional — caso de maior rigor do projeto** | 2026-07-29, livro CRISPR: 12 nomes citados sem formato consistente/sem bibliografia, corrigidos seguindo regra explícita "sem fonte verificável, generalizar, nunca inventar". Codex pesquisou na web, achou fontes reais para 2 autores (com DOI), removeu 2 outros sem fonte segura, tratou disciplina de ano de publicação, e removeu de bônus uma atribuição incorreta não pedida. Verificado via diff + `escritor verify-citations` (0 não localizadas) + `analyze` (0 críticos). Ver Seção 6.3 do `ARTIGO.md`. |
| **Claude → Higgsfield CLI: geração de imagem dedicada (2026-09-10)** | **NOVO HARNESS — funcional, qualidade superior pra capas de livro** | Diferente dos casos anteriores (Codex/agy usando skill de imagem embutida), o Higgsfield é um serviço externo dedicado a imagem/vídeo/3D, com CLI próprio (`@higgsfield/cli`, `npm i -g`). Fluxo de setup: `higgsfield auth login` (OAuth PKCE via navegador, precisou de Claude-in-Chrome pra clicar "Allow" e "Skip" na tela de planos pagos, timeout curto do servidor local ~2min por tentativa — levou 3 tentativas até completar dentro do tempo) → `npx skills add higgsfield-ai/skills` (8 skills complementares, algumas marcadas High/Critical Risk pela varredura automática do instalador, aceitas por vir do repo oficial `higgsfield-ai/skills`) → `higgsfield workspace set <id>` (plano free, 10 créditos). Testado gerando a capa de "Casados Segundo o Coração de Deus" com `higgsfield generate create nano_banana_pro --prompt "..." --aspect-ratio 2:3 --resolution 2k --wait` (2 créditos, ~40s): resultado com tipografia mais precisa (sem os pequenos artefatos de kerning vistos nas capas geradas por Codex/agy/cursor-agent no mesmo livro) e composição mais coerente tematicamente. Achado colateral relevante: a capa gerada pelo `agy` pro mesmo livro tinha vazado literalmente o texto "FOLHA DE ROSTO" (rótulo estrutural interno do manuscrito) pra dentro da arte, mesmo bug de estrutura que existia no `.md` fonte — sinal de que geração de capa alimentada direto pelo manuscrito bruto pode herdar erros editoriais não são só cosméticos. Ver [[project_casados_segundo_coracao_deus_livro]] para o caso completo. |
| **Antigravity/agy → Claude Code CLI: absorção técnica de projeto em produção** | **CASO EMBLEMÁTICO DE SUBPROCESSO DIRETO — funcional (2026-09-29)** | O Antigravity/agy delegou via CLI direta (`claude -p` com `--dangerously-skip-permissions`) a tarefa de leitura e absorção da arquitetura de Contatos do Google (`%USERPROFILE%\Hermes`). O Claude Code executou sem bloqueio em ~25s, utilizou `ripgrep` para inspecionar os arquivos físicos (`SPEC.md` e `contacts_manager.py`), e devolveu um resumo técnico conciso e completo sobre autenticação, escopos, a obrigatoriedade do campo `birthdays`, cache local e convenções de CLI. Confirma de forma definitiva que a proteção antirrecursiva do Claude Code se aplica exclusivamente a instâncias tentando invocar a si mesmas, e que o canal de subprocesso direto opera em harmonia total com o canal assíncrono do Mailbox MCP. |
| **Antigravity/agy → Codex CLI (GPT-6 Sol): análise conceitual em 8s** | **CASO EMBLEMÁTICO COM MODELO DE ÚLTIMA GERAÇÃO — funcional (2026-09-29)** | O Antigravity/agy invocou o Codex CLI v0.157.1 via `codex exec --skip-git-repo-check -s workspace-write -C "%USERPROFILE%\Hermes"` com fechamento de stdin `< nul`. O Codex operou com o modelo `gpt-6-sol`, executou busca `ripgrep` no diretório em 881ms e sintetizou em linguagem natural precisa o propósito do projeto com citação direta de linha do `SPEC.md`. Demonstra velocidade extrema (tempo total de 8 segundos) e valida a sintaxe definitiva necessária no Windows para execução não-bloqueante. |

| **Capacidade de áudio local (nova dimensão testada, 2026-08-05)** | **ver detalhamento abaixo** | Projeto paralelo (`VersiculosBibliaAudio`) precisou que um harness "ouvisse"/avaliasse arquivos `.mp3` locais (verificar corte/completude de narração). Nenhum harness testado tem entrada de áudio nativa de verdade sendo usada com sucesso nesta máquina — os que funcionam o fazem via ferramentas de shell (transcrição Whisper + análise de forma de onda), não multimodalidade nativa. |
| Claude → Antigravity/agy (áudio) | **bloqueado** | mesmo bloqueio de sempre: modo `-p` headless nega automaticamente qualquer permissão de ferramenta (nem lista diretório), sem `--dangerously-skip-permissions` |
| Claude → Gemini CLI (áudio) | **não confirmado — cota esgotada antes de responder** | é o único harness com modalidade de áudio nativa de verdade no modelo subjacente (Gemini), mas bateu no limite gratuito (`generativelanguage.googleapis.com/generate_content_free_tier_requests`, limite 5) antes de produzir uma resposta útil; retestar quando a cota resetar |
| Claude → GitHub Copilot CLI (áudio) | **sem capacidade, admitido pelo próprio harness** | respondeu literalmente "Não consigo ouvir o áudio diretamente"; só executa heurísticas de `ffmpeg silencedetect` como proxy, que se mostraram pouco confiáveis nas gravações do projeto (música de fundo nunca é silêncio digital puro) |
| **Claude → OpenCode (áudio)** | **funcional, via tool-use autônomo** | modelo gratuito configurado (`opencode/big-pickle`, sem áudio nativo) usou sozinho `faster_whisper` (já instalado) + `ffmpeg`/`numpy` para transcrever e analisar a forma de onda, sintetizando uma resposta correta e coerente sobre completude do áudio. Em lote (44 arquivos), causou instabilidade real de processo (múltiplas instâncias concorrentes sobreviveram a `TaskStop`, escreveram no mesmo arquivo de resultado, e deixaram **dezenas de arquivos de script/análise temporários soltos dentro das pastas de áudio do usuário**, exigindo limpeza manual depois) — usar só para arquivo único por vez, não para lote grande sem supervisão apertada. |
| **Claude → Cursor Agent CLI, via WSL (áudio)** | **funcional, via tool-use autônomo** | mesmo padrão do OpenCode: usou `ffmpeg` + Python (numpy) para medir nível de silêncio no início/fim e decaimento de energia, sem precisar instalar nada, resposta coerente e correta (~2 min, mais lento que o OpenCode). Comando: `cursor-agent -p -f "<tarefa>"` dentro do diretório do arquivo (via `wsl -- bash -lc "cd ... && cursor-agent -p -f '...'"`), com `timeout` externo como salvaguarda (histórico de travamentos sem `-f`). |
| Claude → Codex CLI (áudio) | **ainda não testado — cota de uso esgotada** | tentativa em 2026-08-05 retornou `ERROR: You've hit your usage limit... try again at Aug 8th, 2026`. Reflete a mesma "não capacidade de áudio nativa" observada em Copilot/OpenCode/Cursor (todos GPT/Claude por baixo, sem modalidade de áudio no L modelo), mas isso não foi confirmado na prática para o Codex especificamente — retestar após 08/08/2026. |

**Nota sobre Cursor e "VS Code":** confirmado com o usuário: "VS Code" e "Cursor" são produtos distintos que ele usa de fato (não confusão de nomenclatura). O agente headless do Cursor (`cursor-agent`) não tem build nativo Windows — só via WSL, e só a via oficial (`curl https://cursor.com/install`), nunca forks de terceiros "patcheados" encontrados no GitHub/npm (risco de supply-chain, mesmo critério já aplicado ao descartar o npm "antigravity-cli"). O harness "VS Code" propriamente dito, pro propósito do H2H, é o GitHub Copilot CLI (mesma conta/assinatura usada pela extensão dentro do editor).

## 12. Próximos passos (v0.2 e além)

- Retestar Claude → Codex CLI para capacidade de áudio local depois de 08/08/2026 (cota de uso esgotada em 2026-08-05, único harness do roster ainda sem esse teste específico). Ver Seção 11 para o restante da matriz de áudio já preenchida (agy bloqueado, Gemini com cota esgotada antes de responder, Copilot sem capacidade admitida, OpenCode e Cursor Agent CLI funcionais via tool-use).
- Testar a geração de capa de livro pelo Grok (`image_gen`) com o método da skill `imagine`: arte sem texto gerada pela IA, e título, subtítulo e autor compostos por código, para eliminar erros de ortografia na imagem. Incluir o Grok na cadeia automática de capas do `EscritorEvangelico` se o resultado for bom.
- Testar Claude → Grok com `--allow` e `--deny` em vez de `--always-approve` (nível 2) e medir o consumo na conta DeepSeek.
- Testar Codex → Gemini e Codex → Agy (não deve esbarrar na proteção de recursão, já que são produtos diferentes).
- Usuário rodar `cursor-agent login` (WSL) para destravar o teste do Cursor.
- Confirmar o VS Code reinstalado e checar se precisa reconfigurar a extensão Copilot Chat nele.
- ~~Confirmar nome do modelo "GPT sol 5.6"~~ RESOLVIDO 2026-07-26: nome oficial é "GPT-5.6 Sol", confirmado por print da própria interface do Codex CLI.
- ~~Confirmar model IDs exatos no Copilot~~ RESOLVIDO 2026-07-27: slug confirmado é `gpt-5.6-sol` (ver manifesto do Copilot na Seção 5), mas está bloqueado pelo plano Free da conta do autor — precisa upgrade pra usar de fato. Falta ainda confirmar os slugs no Cursor especificamente.
- Investigar se ACP pode substituir o parsing de flags nativas como transporte para harnesses que já o suportam (Copilot, OpenCode), mantendo fallback de CLI para os que não suportam.
- Escrever um wrapper de referência (script único) que recebe um Descritor de Tarefa e traduz para o comando nativo do harness alvo, usando os manifestos da seção 5.
- Definir regra de política automática de roteamento (ex: tarefa marcada como "raciocínio pesado" → Codex/melhor LLM disponível; tarefa de continuidade/contexto → permanece no harness atual).
- Avaliar suporte a saída estruturada (JSON) como padrão em vez de texto livre, usando os modos já existentes em cada CLI.
- Decidir se este documento continua uso pessoal ou vira repositório público (LICENSE MIT, "by Jair Lima", conforme convenção pessoal de projetos).
- ~~Integrar Higgsfield CLI na cadeia automática de geração de capa do `EscritorEvangelico`~~ RESOLVIDO 2026-09-10: adicionado como 4ª opção (`capa-higgsfield.png`) em `export_docx.py` (`_generate_cover_higgsfield` + `_build_cover_prompt_higgsfield`), testado isoladamente de ponta a ponta com sucesso. Dois bugs reais encontrados e corrigidos no processo: (1) prompt multi-linha corrompia o parsing de argumentos ao passar pelo shim `.CMD` do `higgsfield` no Windows — `--aspect-ratio 2:3` era silenciosamente ignorado (saía 1:1/1024×1024 sem nenhum erro reportado), corrigido forçando o prompt do Higgsfield a ficar numa única linha; (2) `_extract_title_and_subtitle` (função **compartilhada pelos 4 harnesses**, não só Higgsfield) capturava o heading estrutural `## Folha de Rosto` como se fosse o subtítulo do livro — confirma e corrige a causa raiz do defeito visto na capa do `agy` pro livro "Casados Segundo o Coração de Deus" (texto "FOLHA DE ROSTO" vazando pra dentro da arte gerada). Corrigido com lista de headings estruturais a ignorar + fallback pra pegar a linha de texto simples depois do título repetido em negrito. Ambos os fixes beneficiam os 4 harnesses de capa, não só o novo.

## 13. Notas de implementação: invocando harnesses via Python no Windows

Achados verificados empiricamente em 2026-07-27/28 (contribuição de outra sessão do usuário, construindo o primeiro wrapper real que chama Codex programaticamente), relevantes para qualquer implementação futura do wrapper de referência (item da Seção 12):

1. **CLIs instaladas via `npm install -g` no Windows são scripts `.cmd`, não `.exe`.** `subprocess.run(["codex", ...])` sem `shell=True` falha silenciosamente ou não encontra o executável, porque o `CreateProcess` do Windows não executa `.cmd`/`.bat` diretamente (não são binários PE). **Correção:** resolver o caminho completo do executável antes de chamar (ex: `shutil.which("codex")`, que respeita `PATHEXT` e retorna o `.cmd`); com o caminho completo resolvido, o `subprocess` do Python detecta a extensão e invoca corretamente via `cmd.exe` por trás. Isso vale para qualquer harness instalado via npm (Codex, Gemini CLI, agy, OpenCode), não é específico do Codex.
2. **Encoding padrão do Windows em português não é UTF-8.** Ao capturar stdout de um harness via subprocess sem especificar encoding, o Python usa o encoding padrão do sistema (tipicamente cp1252 em Windows pt-BR), o que quebra ao decodificar saída UTF-8 com acentos (praticamente garantido, já que todo harness testado neste projeto responde com acentuação correta em português). **Correção:** sempre especificar `encoding="utf-8"` explicitamente ao capturar saída de qualquer harness.

Ambos os problemas são genéricos de "invocar CLI Node.js via Python no Windows", não específicos de nenhum harness em particular — mas são exatamente o tipo de detalhe que travaria silenciosamente um wrapper de referência do H2H em produção se não for tratado desde o início.

3. **Disciplina de supervisão: um monitor por tarefa delegada, nunca mais.** Achado em 2026-07-29: ao acompanhar uma tarefa longa via monitoramento de eventos em tempo real, é comum (aconteceu com mais de uma sessão Claude Code diferente, inclusive a que mantém este documento) criar monitores adicionais duplicados por ansiedade/impaciência em vez de simplesmente aguardar a notificação do monitor original. Isso não quebra nada, mas gera ruído e trabalho de limpeza desnecessário. **Regra:** ao iniciar o acompanhamento de uma tarefa delegada em background, criar exatamente um monitor e aguardar sua notificação de conclusão; não criar monitores "de checagem" ou "placeholder" adicionais para a mesma tarefa.

## 14. Caso real: Grok com DeepSeek assume a escrita de um livro quando o agy falha (2026-10-06)

Contexto: um lote de 49 capítulos do livro "Godot com Vibe Coding" foi delegado ao Antigravity (`agy`). Três falhas distintas do `agy` apareceram, todas de infraestrutura e nenhuma de capacidade:

1. `Eligibility check failed: UNAVAILABLE (code 503)`, resolvido pelo autor com `agy update` (1.2.17 para 1.3.0), conforme a documentação.
2. `RESOURCE_EXHAUSTED (code 429): Individual quota reached... Resets in 1h10m` (e depois `20h53m`), que o autor informou não ser cota real (plano amplo, nunca esgotou). O log indicava cota, mas um teste mínimo funcionava pouco depois: o texto do erro não era confiável como diagnóstico.
3. O `agy` lançando um comando do Godot em segundo plano, esperando 30 min por "tarefa pendente" e saindo sem gravar o arquivo do capítulo (capítulos 12 e 30). Mitigação aplicada ao modelo de tarefa: rodar o Godot em primeiro plano com `--quit-after` e gravar o arquivo antes das validações demoradas.

Resposta H2H: o orquestrador (Claude Code) passou os capítulos pendentes (12, 21 e 30) e depois os 9 apêndices ao Grok CLI com DeepSeek V4 Pro, com o mesmo Descritor de Tarefa (modelo de instrução em arquivo, caminhos absolutos, regras de estilo, verificação obrigatória no Godot). Resultado verificado pelo orquestrador: capítulos entre 3.200 e 4.100 palavras, zero travessão, suítes do Godot aprovadas com saídas reais citadas, bloco de continuidade acrescentado ao registro compartilhado.

Segunda tarefa delegada ao Grok: reconstruir o histórico Git do projeto Arena 2D (um commit e uma tag por checkpoint) numa cópia, com PORTÃO objetivo: `git diff` entre o último commit reconstruído e o commit original, vazio, ignorando 2 arquivos declarados. O Grok passou no portão e, de modo relevante para o protocolo, relatou 5 inconsistências nos capítulos em vez de escondê-las (por exemplo, um capítulo mostrava o jogo inteiro já no commit inicial, e outro dependia de um arquivo só criado no passo seguinte). O orquestrador conferiu o diff por conta própria antes de trocar o repositório.

Lições para o protocolo:

- Diagnóstico: a mensagem de erro do harness chamado não prova a causa (caso do falso 429). Testar com chamada mínima antes de aguardar reset, e avisar o usuário com o texto exato do erro.
- Fallback entre harnesses por falha de infraestrutura é viável quando o Descritor de Tarefa é um arquivo autocontido. Manter o modelo de instrução em arquivo, e não só no prompt, foi o que permitiu trocar de executor sem perder as regras de estilo.
- Delegar com portão verificável (diff vazio, suíte de testes, contagem de palavras, regex de proibições) e conferir o portão no orquestrador.
- Provedores customizados mudam o significado de "qual harness": o Grok CLI roteou para a DeepSeek. O H2H deve registrar harness e provedor/modelo separadamente e não confiar na autodeclaração do modelo.
- Compatibilidade de provedores (pesquisa e conversa direta com cada harness em 2026-10-06): o Gemini CLI respondeu que só aceita modelos Gemini; o `agy models` lista Gemini, Claude e GPT-OSS, sem DeepSeek; o Cursor Agent CLI disse que DeepSeek não consta na documentação e que a chave aceita é a do Cursor, embora guias da comunidade citem "Add Model" com URL base; o Grok CLI aceita por configuração oficial.
- Defeito no entregável: uma capa de livro gerada por outro harness saiu com "Juegos" no lugar de "Jogos" e a frase do topo cortada. O orquestrador não deve apenas relatar o defeito: refaz ou remove o arquivo defeituoso, e confere o texto de capa letra por letra.

Terceiro uso no mesmo dia, como revisor independente antes de publicar: ao preparar o repositório público do livro, o Codex foi acionado em modo somente leitura para revisar segredos, dados pessoais, licenças e coerência do README, mas atingiu o limite de uso da conta ChatGPT no meio da revisão (`You've hit your usage limit ... try again at 9:06 PM`) e não concluiu. A mesma revisão, com o mesmo prompt e numa cópia descartável do repositório, foi feita pelo Grok com DeepSeek V4 Pro (API pré-paga, sem limite de assinatura). Veredito: nada bloqueia a publicação, mas ele encontrou um problema real que o orquestrador e os testes não tinham visto: dois documentos de procedência de assets (`LICENSES.md` e `PROVENANCE.md`) citavam ferramentas de IA, autores e arquivos que não existiam no projeto, e três ledgers atribuíam o `icon.svg` ao logotipo do Godot quando o arquivo era um SVG simples escrito como código. A correção foi aplicada na origem e conferida pelos testes do projeto, o que também mostrou que reescrever o documento por inteiro quebrava dois testes de conformidade; a solução foi manter a tabela como exemplo didático, com aviso explícito no topo. Lição: documentos de conformidade gerados por agentes podem conter fatos inventados com aparência de rigor, e uma segunda opinião de outro harness, com o mesmo prompt, é barata e achou o que a primeira linha de verificação não achou.

## 15. Ferramenta REA (Reverse Engineer Anything) como Serviço MCP Compartilhado (2026-10-15)

Em 2026-10-15, a ferramenta oficial **REA (Reverse Engineer Anything)** v6.5.0 (`morluto/rea`) foi instalada globalmente via npm (`rea-agents`) e homologada como serviço utilitário compartilhado para o ecossistema H2H.

### O que o REA oferece aos harnesses:
1. **Engenharia Reversa e Inspeção Local:** Capacidade de inspecionar binários compilados (PE, ELF, Mach-O), assemblies .NET, pacotes de aplicativos Electron (.asar), APKs do Android, esquemas SQLite e fluxos de rede/web (HAR/CDP).
2. **Integração com Decompiladores:** Conexão com Ghidra, IDA Pro, Hopper e WABT locais, com diagnósticos preservados.
3. **Disponibilidade via CLI:** Instalado no PATH global em `%USERPROFILE%\bin\rea.cmd` e `%USERPROFILE%\bin\rea.ps1`.
4. **Disponibilidade via Servidor MCP:** Registrado sob o identificador `rea` no Antigravity (`~/.gemini/config/mcp_config.json`) e no Claude Code (`~/.claude.json`), oferecendo mais de 200 ferramentas analíticas de execução 100% local.
5. **Motor de Descompilação Ghidra 12.1.4 e JDK 21:** Configurado com suporte a binários MS-DOS MZ (`dos-mz` e `dos-com`) em modo real x86 de 16 bits (`x86:LE:16:Real Mode`), com timeout estendido de inicialização (`REA_GHIDRA_STARTUP_TIMEOUT_MS = 900000`).
6. **Uso pelos harnesses:**
   * **Claude Code e Antigravity:** Invocações diretas via MCP (ex: `binary_session`, `inspect-signature`, `search`, `procedure_pseudo_code`, etc.).
   * **Codex CLI e Grok CLI:** Invocações diretas via CLI (`rea <comando>`) ou por subprocesso no Windows e WSL.

