# Documento Técnico — Cabo de Guerra Online

Projeto da disciplina **Arena Distribuída (5º Semestre)**.
Stack: Node.js + Express + Socket.IO, front-end em HTML/CSS/JavaScript puro.

---

## 1. Visão geral

O sistema é um jogo multiplayer em tempo real acessado pelo navegador. Dois jogadores
pressionam repetidamente um botão para "puxar" uma corda; a barra central se desloca para o
lado de **quem clicou menos** e a partida termina quando a barra atinge um dos extremos.

O que está sendo avaliado é a **comunicação distribuída**, não o jogo:

- o **servidor é autoritativo**: o cliente nunca decide o resultado, apenas envia a intenção
  `tap` e renderiza o estado que recebe;
- o estado é mantido **em memória**, sem banco de dados;
- os participantes são identificados por **papel** (Jogador 1, Jogador 2, Espectador).

---

## 2. Arquitetura

```
   ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
   │ Navegador A  │        │ Navegador B  │        │ Navegador C  │
   │ Jogador 1    │        │ Jogador 2    │        │ Espectador   │
   └──────┬───────┘        └──────┬───────┘        └──────┬───────┘
          │  WebSocket (Socket.IO) — conexão persistente bidirecional
          └───────────────┬───────┴───────────────────────┘
                          ▼
                ┌───────────────────────────┐
                │      server.js            │
                │  (servidor autoritativo)  │
                │                           │
                │  rooms: Map<code, room>   │   estado em memória
                │  socketInfo: Map<id, …>   │
                │  quickQueue: [ ]          │
                └───────────────────────────┘
                          │
               Express serve /public (HTML/CSS/JS)
```

**Por que WebSocket e não HTTP/polling:** o jogo gera um volume alto e contínuo de mensagens
pequenas nos dois sentidos, com latência que precisa ser imperceptível (RNF03). No modelo
requisição-resposta o cliente teria que perguntar ao servidor dezenas de vezes por segundo
(polling), gastando banda e adicionando atraso. A conexão persistente bidirecional do
WebSocket permite que o servidor **empurre** o estado assim que ele muda, sem o cliente pedir.

### 2.1 Organização do código do cliente

O cliente separa três responsabilidades (objetivo de aprendizagem da disciplina):

- **estado** — objeto `state` em [`public/client.js`](../public/client.js);
- **comunicação** — eventos Socket.IO (`socket.emit` / `socket.on`);
- **renderização** — funções `renderBar`, `renderTaps`, `renderHud`, `renderRoom`, etc.

### 2.2 Isolamento entre partidas

Cada sala é um canal Socket.IO independente (`socket.join(code)`); o servidor transmite
sempre com `io.to(room.code)`, de modo que mensagens de uma sala **nunca** chegam a outra.
O servidor mantém quantas salas simultâneas a memória permitir.

---

## 3. Papéis e lobby

- **Jogador 1** — criador da sala (ou primeiro da fila).
- **Jogador 2** — quem entra pelo código (ou segundo da fila).
- **Espectador** — a partir do terceiro participante da sala; recebe o mesmo estado, mas não
  pode jogar.

Duas formas de entrar: **criar/entrar por código** (4 caracteres, alfabeto sem caracteres
ambíguos) ou **partida rápida** (fila automática). Não há login nem cadastro; apenas apelido.

---

## 4. Máquina de estados da sala

```
                 ┌──────────────────────────────────────────────┐
                 ▼                                              │
   criar/entrar em sala  ┌──────────┐   p1 e p2 presentes   ┌────┴─────┐
   ─────────────────────►│ waiting  │──────────────────────►│countdown │
                         └──────────┘                       └────┬─────┘
                              ▲                                  │ fim da
                              │                                  │ contagem
              jogador sai/    │                                  ▼
              partida abortada│                            ┌──────────┐
                         ┌────┴─────┐                      │ playing  │
                         │  ended   │◄─────────────────────┤          │
                         └────┬─────┘   barra atinge ±100  └────┬─────┘
                              │                                 │
              revanche: p1 e p2 pedem → volta para countdown    │
                              │                                 │
                              └──── jogador desconecta ─────────┘
                                    → aborta para waiting
```

- `waiting` — sala criada, faltando oponente.
- `countdown` — ambos os jogadores presentes; contagem **sincronizada de 3, 2, 1, GO**.
- `playing` — partida em andamento; o servidor agrega cliques a cada tick.
- `ended` — alguém venceu; placar da sessão atualizado; revanche disponível.

---

## 5. Protocolo de mensagens

Todas as mensagens são eventos Socket.IO com payload JSON. Não há campo `tipo` textual porque
o **próprio nome do evento** já é o tipo.

### 5.1 Cliente → Servidor (intenções)

| Evento | Payload | Descrição |
| --- | --- | --- |
| `room:create` | `{ name: string }` | Cria uma sala e entra como Jogador 1. |
| `room:join` | `{ name: string, code: string }` | Entra em uma sala existente pelo código. |
| `match:quick` | `{ name: string }` | Entra na fila de partida rápida. |
| `tap` | *(vazio)* | Intenção de clique (uma jogada). |
| `rematch:request` | *(vazio)* | Solicita revanche ao final da partida. |
| `room:leave` | *(vazio)* | Sai da sala e/ou da fila. |

O cliente **nunca** informa a posição da barra, o vencedor nem o placar — apenas a intenção.

### 5.2 Servidor → Cliente (fatos autoritativos)

| Evento | Payload | Descrição |
| --- | --- | --- |
| `room:joined` | `{ code, roleKey, role, you:{name}, state, scores, players, spectators, ready, match:{bar,version,state} }` | Confirmação de entrada, com o papel atribuído. |
| `room:update` | `{ code, state, scores, players, spectators, ready }` | Atualização do roster/placar da sala. |
| `room:peer:left` | `{ name, role }` | Alguém deixou a sala. |
| `room:left` | *(vazio)* | Confirmação de saída. |
| `quick:waiting` | `{ name }` | Entrou na fila e aguarda oponente. |
| `match:countdown` | `{ value: 3 \| 2 \| 1 \| "GO" }` | Passo da contagem regressiva sincronizada. |
| `match:start` | `{ bar, version, taps, scores }` | Início da partida (barra zerada). |
| `match:update` | `{ bar, version, taps }` | Novo estado da barra após um tick. |
| `match:over` | `{ winnerKey, winnerName, loserName, bar, taps, scores }` | Fim de partida com o resultado. |
| `match:aborted` | `{ who, reason }` | Partida interrompida (ex.: oponente desconectou). |
| `error:msg` | `{ code, message }` | Erro/rejeição enviado apenas ao remetente. |

Códigos de `error:msg`: `NAME`, `CODE`, `NOT_FOUND`, `NOT_PLAYING`, `SPECTATOR`,
`RATE_LIMIT`, `INTERNAL`.

### 5.3 Exemplo de fluxo

```
A → server   room:create {name:"Ana"}
server → A   room:joined {roleKey:"p1", code:"K7QP", …}
B → server   room:join   {name:"Bia", code:"K7QP"}
server → all room:update {players:{p1:"Ana", p2:"Bia"}}
server → all match:countdown {value:3} … {value:"GO"}
server → all match:start {bar:0, version:0}
A → server   tap
A → server   tap
server → all match:update {bar:4, version:1, taps:{p1:2,p2:0}}
… barra chega a +100 …
server → all match:over {winnerKey:"p1", winnerName:"Ana", scores:{p1:1,p2:0}}
```

---

## 6. Regras do jogo no servidor

**Agregação em ticks (tema 6).** Cada `tap` válido apenas incrementa um contador pendente do
jogador. A cada **50 ms (20 ticks/s)** o servidor soma os cliques pendentes e move a barra:

```
barra += (cliquesP1 − cliquesP2) × 2      // limitada a [−100, +100]
versao += 1                               // consistência de estado
transmite match:update para a sala        // apenas se algo mudou no tick
```

Se nenhum clique chegou no tick, **nada é transmitido** — evita tráfego inútil.

**Limitação de taxa (anti-autoclicker).** Cada jogador tem uma janela deslizante de 1 segundo.
Acima de **15 cliques/s** os cliques excedentes são descartados e o servidor responde com
`error:msg { code: "RATE_LIMIT" }` (com intervalo mínimo de 800 ms entre avisos), registrando
`jogada:rejeitada` no log.

**Validação (RF04).** `tap` só é aceito quando `state === "playing"` e o remetente é Jogador 1
ou 2 do próprio socket. Caso contrário é rejeitado com `NOT_PLAYING` ou `SPECTATOR`. Jogadores
não podem jogar por outro; espectadores nunca jogam.

**Vitória.** A barra chega a `+100` → vence o Jogador 1; a `−100` → vence o Jogador 2. O placar
da sessão é incrementado e mantido em memória até a sala esvaziar.

---

## 7. Tratamento de concorrência e falhas

| Situação | Tratamento |
| --- | --- |
| Dois cliques simultâneos de jogadores diferentes | Agregados no mesmo tick pelo contador; sem condição de corrida (servidor single-thread). |
| Rajada de cliques (autoclicker) | Janela deslizante limita a 15/s; excedente rejeitado. |
| Jogador fecha a aba no meio da partida | `disconnect` → partida abortada (`match:aborted`), oponente notificado (`room:peer:left`), sala liberada para nova partida. |
| Servidor recebe mensagem malformada | Todos os handlers são embrulhados em `safeOn`: exceções são capturadas, logadas e devolvidas como `error:msg { code:"INTERNAL" }`; o servidor **não cai** (RNF05). |
| Cliente desconecta na fila | Removido da `quickQueue`. |
| Sala fica vazia | Removida da memória. |
| Ordenação temporal | Decidida pelo relógio do **servidor** (`Date.now()`), inclusive na janela de rate limit — o relógio do cliente não influencia nada. |

---

## 8. Consistência de estado

Cada `match:update` carrega um campo `version` **monotonicamente crescente**. Isso permite ao
cliente detectar e descartar mensagens fora de ordem (a versão só avança) e serve como
evidência, no DevTools, de que todos os participantes recebem a mesma sequência de estados.
Como o servidor difunde via `io.to(room.code)`, todos os clientes da sala recebem exatamente
os mesmos valores de `bar`, `version` e `taps`.

**Perspectiva do jogador.** Internamente a barra vai de −100 (lado do Jogador 1) a +100 (lado
do Jogador 2). Para que cada jogador se veja sempre à esquerda, o cliente do Jogador 2 espelha
a exibição (`displayPct`). A lógica não muda: é apenas apresentação.

---

## 9. Interface

Quatro telas no mesmo documento (`index.html`), trocadas sem recarregar a página:

1. **Lobby** — apelido, criar sala, entrar por código, partida rápida.
2. **Fila** — aguardando oponente na partida rápida.
3. **Sala de espera** — código para compartilhar, papel do usuário, roster, espectadores e
   placar da sessão.
4. **Jogo** — HUD com nomes e contador de cliques, barra central com o "nó", botão `PUXA!`,
   overlay de contagem regressiva e overlay de resultado com revanche.

Layout responsivo (mobile-first) com `@media (max-width: 640px)`; funciona em computador e
celular. Os apelidos são escapados no servidor (`cleanName`) para evitar injeção de HTML.

---

## 10. Decisões de projeto

- **Servidor autoritativo** — nenhuma regra no cliente; impossibilita trapaça por edição de
  JavaScript no navegador.
- **Agregação em ticks (20/s)** — reduz drasticamente o número de mensagens em partidas com
  muitos cliques, sem prejudicar a sensação de tempo real.
- **Salas isoladas por código** — permite partidas independentes e o cenário "jogar com quem
  eu quero", além da fila automática.
- **`version` crescente** — torna a consistência verificável e determinística.
- **Relógio do servidor** — toda decisão temporal (contagem, rate limit) é do servidor.
- **`safeOn`** — robustez a mensagens malformadas sem derrubar o processo.

---

## 11. Limitações conhecidas

- **Estado apenas em memória**: reiniciar o servidor perde salas, partidas e placares.
- **Sem reconexão**: se a página for recarregada, o jogador volta ao lobby (a reconexão com
  token em `sessionStorage` é item de bônus, não implementado).
- **Sem heartbeat explícito/latência na tela**: usa-se o ping/pong padrão do Socket.IO, mas a
  latência não é exibida ao usuário (item de bônus).
- **Times (3×3)**: o tema permite até 3×3; a versão entregue é 1×1 com espectadores.
- **Sem persistência de ranking** entre execuções (fora do escopo do plano).

---

## 12. Perguntas da seção 11 do plano

O arquivo do plano fornecido ao grupo termina na seção 10.1 (rubrica) e **não inclui a seção
11**. Quando as perguntas forem disponibilizadas, esta seção deve ser preenchida com as
respostas correspondentes.
