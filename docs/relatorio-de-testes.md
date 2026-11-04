# Relatório de Testes — Cabo de Guerra Online

Execução do **roteiro de testes da seção 9** do plano da disciplina.

## Como reproduzir

```bash
npm install
npm test
```

A suíte sobe uma instância real do servidor numa porta dedicada e conecta clientes Socket.IO
reais (dois jogadores + espectador), exercitando os cenários abaixo de forma automatizada.

## Resultado da última execução

```
Cabo de Guerra Online — testes do servidor

  ✓ C1/9.1  HTTP serve a interface (servidor ativo)
  ✓ 9.2/RF02  criador entra como Jogador 1
  ✓ RF04  jogada fora de partida e rejeitada
  ✓ RF04  sala inexistente retorna erro
  ✓ 9.2/RF02  segundo entra como Jogador 2
  ✓ RF05  roster sincronizado na sala
  ✓ 9.3/RF02  terceiro entra como Espectador
  ✓ 9.5/RF04  espectador nao pode jogar
  ✓ Tema6  agregacao em ticks move a barra (RF05)
  ✓ Tema6  limite de taxa neutraliza autoclicker
  ✓ 9.4/RF06  partida completa com resultado correto
  ✓ 9.9/RF08  revanche mantem o placar da sessao
  ✓ 9.8/RF07  desconexao aborta a partida e libera a sala
  ✓ 9.8/RF07  servidor continua ativo apos a desconexao
  ✓ 9.7  duas partidas simultaneas nao interferem
  ✓ RNF05  mensagens malformadas nao derrubam o servidor
  ✓ RNF05/RF02  nome com HTML e saneado (anti-XSS)

17/17 cenarios OK
```

## Cenários da seção 9

| # | Cenário | Resultado esperado | Verificação | Status |
| --- | --- | --- | --- | --- |
| 1 | Iniciar o servidor e mostrar IP e porta | Servidor ativo e log visível | Automático: `GET /` responde 200; console imprime `Local` e `Rede` | ✅ |
| 2 | Conectar dois dispositivos físicos | Cada um recebe seu papel (J1 e J2) | Automático (papéis) + **manual** (dois dispositivos reais) | ✅ |
| 3 | Conectar um terceiro navegador | Entra como Espectador | Automático: `roleKey = "spectator"` | ✅ |
| 4 | Jogar uma partida completa | Estado sincronizado; resultado correto | Automático: barra → +100, vencedor J1, placar 1×0 | ✅ |
| 5 | Executar a jogada inválida do tema | Rejeitada, com erro e registro no log | Automático: `NOT_PLAYING` e `SPECTATOR` | ✅ |
| 6 | Teste específico do tema (autoclicker) | Limite de taxa neutraliza o autoclicker | Automático: rajada de 40 cliques → `RATE_LIMIT` | ✅ |
| 7 | Manter duas salas com partidas simultâneas | Nenhuma interferência entre salas | Automático: cliques na sala A não geram `match:update` na sala B | ✅ |
| 8 | Fechar a aba de um jogador no meio da partida | O outro é notificado; servidor continua ativo | Automático: `match:aborted` + `room:peer:left` + `GET /` 200 | ✅ |
| 9 | Pedir revanche | Nova partida na mesma sala com placar atualizado | Automático: novo `match:start` com `scores.p1 = 1` | ✅ |
| 10 | Mostrar o tráfego no DevTools (Network → WS) | Mensagens condizentes com o protocolo | **Manual** — ver roteiro abaixo | ⏳ |

## Detalhamento das evidências automatizadas

- **9.2 / RF02 — papéis:** o criador recebe `room:joined { roleKey:"p1", role:"Jogador 1" }`; o
  segundo recebe `roleKey:"p2"`; o terceiro, `roleKey:"spectator"`. O código tem o formato
  `^[A-Z2-9]{4}$`.
- **RF04 — jogada inválida:** `tap` antes de a partida iniciar → `error:msg { code:"NOT_PLAYING" }`;
  `tap` de espectador → `error:msg { code:"SPECTATOR" }`; `room:join` com código inexistente →
  `error:msg { code:"NOT_FOUND" }`.
- **Tema 6 — agregação:** após 5 cliques, `match:update` chega ao **oponente** com
  `taps.p1 = 5`, `bar > 0` e `version ≥ 1`.
- **Tema 6 — rate limit:** rajada de 40 cliques → `error:msg { code:"RATE_LIMIT" }`, e o
  servidor registra `jogada:rejeitada ... motivo:"rate-limit"`.
- **9.4 / RF06 — partida completa:** cliques contínuos levam a barra a `+100`; o resultado é
  `match:over { winnerKey:"p1", winnerName:"Ana", scores:{p1:1,p2:0} }`.
- **9.9 / RF08 — revanche:** após ambos pedirem revanche, ocorre novo `match:start` com o
  **placar da sessão preservado** e `bar = 0`.
- **9.8 / RF07 — desconexão:** `disconnect` do Jogador 2 → Jogador 1 recebe
  `match:aborted { who:"Bia" }` e `room:peer:left`; o servidor permanece respondendo.
- **9.7 — isolamento:** duas salas independentes; nenhum `match:update` vaza entre elas.
- **RNF05 — robustez:** payloads com tipo inesperado (`room:create` com número), `room:join`
  com `null`, evento desconhecido e `tap` sem sala **não** derrubam o servidor.
- **Anti-XSS:** apelido `<b>Bob</b>` chega como `bBobb` (tags removidas pelo servidor).

## Roteiro manual (dois dispositivos físicos)

Estes itens exigem hardware real e são executados na apresentação:

1. Iniciar o servidor (`npm start`) e anotar o endereço de **Rede** exibido no console.
2. Abrir o endereço de rede em **dois dispositivos diferentes** na mesma rede local.
3. No dispositivo A: apelido + **Criar sala**; anotar o **código**.
4. No dispositivo B: apelido + o **código** + **Entrar** → a partida inicia após a contagem.
5. Abrir um terceiro navegador e entrar na mesma sala → deve aparecer como **Espectador**.
6. **Teste do tema:** abrir o console do navegador em um dispositivo e rodar

   ```js
   setInterval(() => document.querySelector('#tug-btn').click(), 5);
   ```

   O contador de cliques do jogador para de subir além do limite e aparece o aviso de
   `RATE_LIMIT`; o log do servidor registra as jogadas rejeitadas.
7. **DevTools → Network → WS:** selecionar a conexão e conferir que os quadros enviados e
   recebidos correspondem aos eventos documentados (`tap`, `match:update`, `match:over`,
   `error:msg`).
8. Fechar a aba de um jogador no meio da partida → o outro vê o aviso de desconexão e a sala
   é liberada; o servidor continua ativo.

## Conclusão

Os cenários automatizáveis do roteiro (1–9) passam integralmente (17/17 asserções). Os itens
que dependem de hardware real e inspeção visual (cenário 10 e a etapa específica de dois
dispositivos) seguem o roteiro manual acima para a demonstração final.
