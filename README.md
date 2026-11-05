# 🪢 Cabo de Guerra Online

Jogo multiplayer em tempo real para navegador, desenvolvido como projeto da disciplina
**Arena Distribuída — 5º Semestre**. Dois jogadores puxam a corda clicando o mais rápido
possível; a barra central caminha para o lado de **quem clicou menos** até chegar ao fim.

O foco do projeto não é o jogo em si, e sim a **comunicação cliente-servidor**: o servidor
é **autoritativo** (valida tudo e é a única fonte da verdade), os clientes apenas enviam
intenções (`tap`) e renderizam o estado recebido.

## Tecnologias

| Camada | Escolha |
| --- | --- |
| Runtime | Node.js |
| Servidor HTTP | Express |
| Tempo real | Socket.IO (WebSocket) |
| Front-end | HTML + CSS + JavaScript puro (sem framework) |
| Testes | Node + `socket.io-client` |

Não há banco de dados: conexões, salas e partidas ficam **em memória**.

## Como instalar e executar

Pré-requisito: Node.js 18 ou superior.

```bash
npm install
npm start
```

O servidor sobe em `http://localhost:3000` e imprime no console os endereços da rede local:

```
  🪢  Cabo de Guerra Online — servidor ativo
      Local:   http://localhost:3000
      Rede:    http://192.168.0.15:3000
      Ticks:   20/s | Limite: 15 cliques/s por jogador
```

Para usar outra porta: `PORT=3210 npm start` (Windows PowerShell: `$env:PORT=3210; npm start`).

## Como jogar com outra pessoa (dois dispositivos)

1. **Máquina que roda o servidor**: abra o navegador em `http://localhost:3000`.
2. **Outro dispositivo na mesma rede**: abra o endereço de **Rede** mostrado no console
   (ex.: `http://192.168.0.15:3000`). O Windows Firewall pode pedir para liberar a porta.
3. **Jogador 1**: digite o **nome** e clique em **Criar sala**. Um **código de 4 caracteres**
   aparece (ex.: `K7QP`).
4. **Jogador 2**: no outro dispositivo, digite o **nome**, informe esse código e clique em
   **Entrar**. A partida começa sozinha após a contagem regressiva.
5. A partir do terceiro participante, quem entrar vira **Espectador** e assiste à partida.
6. Também há **Partida rápida (fila)**: dois jogadores que escolherem essa opção são pareados
   automaticamente.

Se aparecer `EADDRINUSE: address already in use`, já existe um servidor na porta. Libere com
(PowerShell):

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## Como jogar

- Clique no botão **Clique aqui rapidão!!**, na arena ou aperte **Espaço** (o mais rápido que
  conseguir).
- Cada clique empurra a barra para o lado do adversário. A partida termina quando a barra
  chega a −100 ou +100; **vence quem clicou mais**.
- No topo da tela de jogo há **Reiniciar** (começa uma nova partida na hora, sem esperar o
  fim) e **Voltar ao início** (sai da sala e volta ao lobby a qualquer momento).
- Ao final, os dois podem pedir **revanche** sem sair da sala; o **placar da sessão** é mantido.
- O servidor limita a **15 cliques por segundo** por jogador para neutralizar autoclickers.

## Testes automatizados

```bash
npm test
```

Sobe uma instância do servidor numa porta de teste e valida, com clientes Socket.IO reais,
os cenários do roteiro de testes (papéis, espectador, jogada inválida, rate limit, partida
completa, revanche, desconexão, isolamento entre salas e robustez a mensagens malformadas).
O resultado detalhado está em [`docs/relatorio-de-testes.md`](docs/relatorio-de-testes.md).

## Estrutura do projeto

```
server.js                 Servidor autoritativo (Express + Socket.IO)
public/
  index.html              Telas: lobby, fila, sala de espera e jogo
  client.js               Estado, renderização e comunicação (separados)
  style.css               Estilo responsivo (mobile-first)
test/run-tests.js         Suíte de testes automatizados do servidor
docs/
  documento-tecnico.md    Arquitetura, protocolo, máquina de estados e decisões
  relatorio-de-testes.md  Resultado de cada cenário da seção 9 do plano
  declaracao-uso-ia.md    Declaração de uso de IA
```

## Documentação

- [`docs/documento-tecnico.md`](docs/documento-tecnico.md) — arquitetura, diagrama, protocolo
  de mensagens e máquina de estados.
- [`docs/relatorio-de-testes.md`](docs/relatorio-de-testes.md) — relatório de testes.
- [`docs/declaracao-uso-ia.md`](docs/declaracao-uso-ia.md) — declaração de uso de IA.

## Integrantes

| Integrante | Papel |
| --- | --- |
| Juan Victor Bolderini Menecucci | Coordenação e integração · Servidor e comunicação · Regras do jogo |
| Douglas Lelis | Interface web · Qualidade e documentação · Regras do jogo |
