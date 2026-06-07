/**
 * Mascote Interativo de Login - Cyber Monkey (Versão Cibernética Geométrica Premium)
 * Encapsula de forma limpa e isolada todos os estilos, HTML e comportamentos do mascote.
 * Focado no conceito de escalabilidade e trading de alta performance.
 */

document.addEventListener('DOMContentLoaded', () => {
  const loginCard = document.querySelector('.login');
  if (!loginCard) return;

  // 1. Injetar Estilos CSS do Mascote e Candlesticks
  const style = document.createElement('style');
  style.textContent = `
    /* Estilos do Mascote Interativo (Macaco Escalador) */
    .login-wrapper {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-top: 110px; /* Dá espaço generoso para o macaco acima */
      margin-bottom: 20px;
      width: 100%;
      position: relative;
    }
    
    .mascot-container {
      width: 260px;
      height: 180px;
      position: absolute;
      top: -142px; /* Encaixa as mãos perfeitamente no topo do card */
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      user-select: none;
      z-index: 10;
    }

    #mascot {
      pointer-events: auto;
      cursor: pointer;
    }

    /* Respiração do Macaco (balanço sutil pendurado pelas mãos) */
    @keyframes monkeyBreathing {
      0%, 100% { transform: translateY(0px) scaleY(1); }
      50% { transform: translateY(-3px) scaleY(0.97) rotate(0.5deg); }
    }
    
    #monkey-upper {
      animation: monkeyBreathing 4.8s ease-in-out infinite;
      transform-origin: 130px 142px; /* Ponto de apoio nas mãos */
    }

    /* Cauda balançando suavemente em estado inativo */
    @keyframes tailWiggleMonkey {
      0%, 100% { transform: rotate(0deg) translateY(0); }
      50% { transform: rotate(-5deg) translateY(-2px); }
    }
    #monkey-tail {
      animation: tailWiggleMonkey 4.5s ease-in-out infinite;
      transform-origin: 138px 125px;
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* Orelhas mexendo sutilmente como radar */
    @keyframes earMoveRightMonkey {
      0%, 90%, 100% { transform: rotate(0deg); }
      93%, 97% { transform: rotate(-3deg); }
    }
    @keyframes earMoveLeftMonkey {
      0%, 88%, 100% { transform: rotate(0deg); }
      91%, 95% { transform: rotate(3deg); }
    }
    #ear-right-group {
      animation: earMoveRightMonkey 6.5s ease-in-out infinite;
      transform-origin: 168px 68px;
      transition: transform 0.3s ease;
    }
    #ear-left-group {
      animation: earMoveLeftMonkey 6.5s ease-in-out infinite;
      transform-origin: 92px 68px;
      transition: transform 0.3s ease;
    }

    /* Captura rápida com a Cauda (BUY) */
    @keyframes tailCatchMonkey {
      0% { transform: rotate(0deg); }
      25% { transform: rotate(35deg) scale(1.1); }
      50% { transform: rotate(-55deg) translate(25px, -20px) scale(1.2); }
      75% { transform: rotate(10deg); }
      100% { transform: rotate(0deg); }
    }
    .monkey-catching #monkey-tail {
      animation: none !important;
      animation: tailCatchMonkey 0.58s cubic-bezier(0.16, 1, 0.3, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Defesa / Chicotada com a cauda (SELL) */
    @keyframes tailDeflectMonkey {
      0% { transform: rotate(0deg); }
      30% { transform: rotate(-25deg) scale(0.9); }
      50% { transform: rotate(45deg) translate(-10px, 15px) scale(1.1); }
      75% { transform: rotate(-10deg); }
      100% { transform: rotate(0deg); }
    }
    .monkey-deflecting #monkey-tail {
      animation: none !important;
      animation: tailDeflectMonkey 0.55s cubic-bezier(0.16, 1, 0.3, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Animação de Escalada Acrobática / BOOST */
    @keyframes monkeyClimbAnimation {
      0% { transform: scale(1) translateY(0) rotate(0deg); }
      20% { transform: scale(0.95) translateY(10px) rotate(-5deg); }
      50% { transform: scale(1.08) translateY(-90px) rotate(360deg); }
      80% { transform: scale(0.97) translateY(5px) rotate(-2deg); }
      100% { transform: scale(1) translateY(0) rotate(0deg); }
    }
    .monkey-climbing {
      animation: monkeyClimbAnimation 0.72s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Animação de Segurança: Cobre os olhos com as mãos cibernéticas (🙈 Não Vejo) */
    .monkey-covering #monkey-arm-left {
      transform: translate(25px, -65px) rotate(45deg) !important;
    }
    .monkey-covering #monkey-arm-right {
      transform: translate(-25px, -65px) rotate(-45deg) !important;
    }
    .monkey-covering #monkey-pupil {
      transform: scaleY(0.05) !important;
      opacity: 0.3;
    }
    .monkey-covering #monkey-visor-back {
      fill: #064e3b !important; /* Visor escurece (verde florestal escuro) */
      filter: none !important;
    }

    /* Estilo das Partículas de Trading (Velas de Candlestick) */
    .data-candle {
      position: absolute;
      pointer-events: none;
      z-index: 5;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      transition: opacity 0.2s, transform 0.2s;
    }

    .candle-wick {
      width: 2px;
      height: 24px;
      position: absolute;
      z-index: 1;
    }

    .candle-body {
      width: 10px;
      height: 12px;
      border-radius: 2px;
      position: relative;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 8px;
      font-weight: 800;
      color: #ffffff;
      font-family: monospace;
    }

    .candle-green .candle-wick { background: #10b981; }
    .candle-green .candle-body {
      background: rgba(16, 185, 129, 0.25);
      border: 1.5px solid #10b981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
    }

    .candle-red .candle-wick { background: #ef4444; }
    .candle-red .candle-body {
      background: rgba(239, 68, 68, 0.25);
      border: 1.5px solid #ef4444;
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
    }
  `;
  document.head.appendChild(style);

  // 2. Embrulhar dinamicamente a caixa de login em um wrapper se não estiver embrulhado
  let wrapper = document.querySelector('.login-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'login-wrapper';
    loginCard.parentNode.insertBefore(wrapper, loginCard);
    wrapper.appendChild(loginCard);
  }

  // 3. Criar e injetar o SVG do Macaco Cibernético (Cyber Monkey)
  const mascotContainer = document.createElement('div');
  mascotContainer.className = 'mascot-container';
  mascotContainer.innerHTML = `
    <svg id="mascot" width="260" height="180" viewBox="0 0 260 180" style="overflow: visible;">
      <defs>
        <!-- Gradiente Metálico Cromado para as partes estruturais do Macaco -->
        <linearGradient id="metalGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#cbd5e1" /> <!-- Alumínio Brilhante -->
          <stop offset="50%" stop-color="#64748b" /> <!-- Aço Escovado -->
          <stop offset="100%" stop-color="#334155" /> <!-- Titânio Escuro -->
        </linearGradient>

        <!-- Gradiente Escuro para as Juntas e Detalhes Internos -->
        <linearGradient id="darkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#475569" />
          <stop offset="100%" stop-color="#0f172a" />
        </linearGradient>

        <!-- Gradiente Creme para Focinho e Placa Peitoral -->
        <linearGradient id="cremeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#f8fafc" />
          <stop offset="100%" stop-color="#cbd5e1" />
        </linearGradient>

        <!-- Gradiente Neon Verde de Lucro (Cores Ativas) -->
        <linearGradient id="neonProfit" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#34d399" /> <!-- Verde Menta -->
          <stop offset="100%" stop-color="#059669" /> <!-- Verde Esmeralda -->
        </linearGradient>

        <!-- Gradiente Verde Padrão do Visor -->
        <linearGradient id="visorGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#34d399" />
          <stop offset="100%" stop-color="#10b981" />
        </linearGradient>

        <!-- Gradiente Neon Verde para Colisão BUY -->
        <linearGradient id="neonGreen" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#10b981" />
          <stop offset="100%" stop-color="#047857" />
        </linearGradient>

        <!-- Gradiente Neon Vermelho para Colisão SELL -->
        <linearGradient id="neonRed" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f43f5e" />
          <stop offset="100%" stop-color="#be123c" />
        </linearGradient>

        <!-- Filtro Glow para Efeito Neon -->
        <filter id="neonGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <!-- Grupo Principal do Macaco -->
      <g id="monkey" style="transform-origin: 130px 142px;">
        <!-- Sombra de Contato sutil no topo do card -->
        <ellipse cx="130" cy="142" rx="42" ry="3" fill="#000000" opacity="0.5" />

        <!-- Grupo Superior (Sofre Respiração e Ações) -->
        <g id="monkey-upper">
          
          <!-- Cauda Preênsil Longa (Lado Direito) -->
          <g id="monkey-tail">
            <!-- Trajetória curva estilizada da cauda -->
            <path d="M 138,124 Q 165,135 185,115 T 210,85 T 225,100" fill="none" stroke="url(#metalGrad)" stroke-width="6.2" stroke-linecap="round" />
            <!-- LED indicador de carga na ponta da cauda -->
            <circle id="tail-led" cx="225" cy="100" r="5.5" fill="url(#visorGrad)" stroke="#047857" stroke-width="1" filter="url(#neonGlow)" />
          </g>

          <!-- Pernas Mecânicas Dobradas -->
          <g id="monkey-legs">
            <!-- Perna Esquerda -->
            <path d="M 118,126 L 108,142 Q 102,148 112,148" fill="none" stroke="url(#metalGrad)" stroke-width="5.5" stroke-linecap="round" />
            <!-- Perna Direita -->
            <path d="M 142,126 L 152,142 Q 158,148 148,148" fill="none" stroke="url(#metalGrad)" stroke-width="5.5" stroke-linecap="round" />
          </g>

          <!-- Corpo/Tronco Geométrico -->
          <polygon id="monkey-body" points="112,94 148,94 140,128 120,128" fill="url(#metalGrad)" stroke="#1e293b" stroke-width="1.5" stroke-linejoin="round" />
          <!-- Placa Peitoral de Feedback Neon -->
          <polygon points="118,98 142,98 136,122 124,122" fill="url(#cremeGrad)" opacity="0.18" stroke="#cbd5e1" stroke-width="0.8" />

          <!-- Cabeça do Macaco -->
          <g id="monkey-head" style="transform-origin: 130px 72px;">
            
            <!-- Orelhas Redondas Mecânicas Grandes -->
            <g id="ear-left-group">
              <circle cx="92" cy="68" r="16" fill="url(#metalGrad)" stroke="#1e293b" stroke-width="1.5" />
              <circle cx="92" cy="68" r="10" fill="url(#darkGrad)" />
              <circle cx="92" cy="68" r="4.5" fill="url(#visorGrad)" filter="url(#neonGlow)" id="ear-led-left" />
            </g>
            <g id="ear-right-group">
              <circle cx="168" cy="68" r="16" fill="url(#metalGrad)" stroke="#1e293b" stroke-width="1.5" />
              <circle cx="168" cy="68" r="10" fill="url(#darkGrad)" />
              <circle cx="168" cy="68" r="4.5" fill="url(#visorGrad)" filter="url(#neonGlow)" id="ear-led-right" />
            </g>

            <!-- Face Principal -->
            <ellipse cx="130" cy="72" rx="28" ry="24" fill="url(#metalGrad)" stroke="#1e293b" stroke-width="1.5" />
            
            <!-- Focinho Macio Creme (Muzzle) -->
            <path d="M 112,78 Q 130,68 148,78 Q 152,90 130,94 Q 108,90 112,78 Z" fill="url(#cremeGrad)" stroke="#cbd5e1" stroke-width="1" />
            <!-- Detalhes do Nariz e Boca -->
            <ellipse cx="130" cy="79" rx="3.5" ry="2.2" fill="#1e293b" />
            <path d="M 124,84 Q 130,88 136,84" fill="none" stroke="#1e293b" stroke-width="1.2" stroke-linecap="round" />

            <!-- Visor Ocular Digital (Olhos de Trading) -->
            <path id="monkey-visor-back" d="M 108,62 L 152,62 Q 156,76 150,78 L 110,78 Q 104,76 108,62 Z" fill="url(#visorGrad)" stroke="#047857" stroke-width="1.2" filter="url(#neonGlow)" />
            
            <!-- Globos Oculares Normais -->
            <ellipse cx="120" cy="70" rx="4.5" ry="6.2" fill="#ffffff" />
            <ellipse cx="140" cy="70" rx="4.5" ry="6.2" fill="#ffffff" />

            <!-- Pupilas Oculares que reagem ao mouse -->
            <g id="monkey-pupil" style="transition: transform 0.12s ease-out;">
              <circle cx="120" cy="70" r="2.2" fill="#000000" />
              <circle cx="119.2" cy="69" r="0.7" fill="#ffffff" />
              <circle cx="140" cy="70" r="2.2" fill="#000000" />
              <circle cx="139.2" cy="69" r="0.7" fill="#ffffff" />
            </g>
          </g>

          <!-- Braços Escaladores Longos (Apoiados no card) -->
          <!-- Braço Esquerdo -->
          <g id="monkey-arm-left" style="transform-origin: 112px 98px; transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);">
            <line x1="112" y1="98" x2="88" y2="116" stroke="url(#metalGrad)" stroke-width="6.5" stroke-linecap="round" />
            <line x1="88" y1="116" x2="92" y2="142" stroke="url(#metalGrad)" stroke-width="5.5" stroke-linecap="round" />
            <ellipse cx="92" cy="142" rx="7.5" ry="4.5" fill="#1e293b" stroke="url(#visorGrad)" stroke-width="1" />
          </g>
          
          <!-- Braço Direito -->
          <g id="monkey-arm-right" style="transform-origin: 148px 98px; transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);">
            <line x1="148" y1="98" x2="172" y2="116" stroke="url(#metalGrad)" stroke-width="6.5" stroke-linecap="round" />
            <line x1="172" y1="116" x2="168" y2="142" stroke="url(#metalGrad)" stroke-width="5.5" stroke-linecap="round" />
            <ellipse cx="168" cy="142" rx="7.5" ry="4.5" fill="#1e293b" stroke="url(#visorGrad)" stroke-width="1" />
          </g>

        </g>
      </g>
    </svg>
  `;
  wrapper.insertBefore(mascotContainer, loginCard);

  // 4. Lógica Ocular, Reações a Campos de Login e Caça a Candles
  const mascot = document.getElementById('mascot');
  const monkeyPupil = document.getElementById('monkey-pupil');
  const monkeyUpper = document.getElementById('monkey-upper');
  
  const earLedLeft = document.getElementById('ear-led-left');
  const earLedRight = document.getElementById('ear-led-right');
  const tailLed = document.getElementById('tail-led');
  const visorBack = document.getElementById('monkey-visor-back');
  
  let isHunting = false;
  let isCovering = false;
  let lastMouseMoveTime = Date.now();
  let idleEyeTimer = null;

  // Atualização das pupilas com base no mouse (coordenada central aproximada X=130, Y=70 na cabeça)
  function updatePupil(targetX, targetY) {
    if (!monkeyPupil || !mascot || isHunting || isCovering) return;
    
    const rect = mascot.getBoundingClientRect();
    const scaleX = rect.width / 260;
    const scaleY = rect.height / 180;
    
    const eyeCenterX = rect.left + 130 * scaleX;
    const eyeCenterY = rect.top + 70 * scaleY;
    
    const dx = targetX - eyeCenterX;
    const dy = targetY - eyeCenterY;
    const distance = Math.hypot(dx, dy);
    
    const maxOffset = 2.4;
    const intensity = Math.min(distance / 200, 1);
    const angle = Math.atan2(dy, dx);
    
    monkeyPupil.style.transform = `translate(${Math.cos(angle) * maxOffset * intensity}px, ${Math.sin(angle) * maxOffset * intensity}px)`;
  }

  document.addEventListener('mousemove', (event) => {
    lastMouseMoveTime = Date.now();
    if (idleEyeTimer) {
      clearInterval(idleEyeTimer);
      idleEyeTimer = null;
    }
    updatePupil(event.clientX, event.clientY);
  });

  // Loop de varredura das pupilas quando inativo
  function startIdleEyes() {
    if (idleEyeTimer) return;
    idleEyeTimer = setInterval(() => {
      if (Date.now() - lastMouseMoveTime < 3000 || isHunting || isCovering) return;
      const angle = Math.random() * Math.PI * 2;
      const offset = Math.random() * 2.4;
      
      if (monkeyPupil) {
        monkeyPupil.style.transform = `translate(${Math.cos(angle) * offset}px, ${Math.sin(angle) * offset}px)`;
        if (Math.random() < 0.25) {
          const randColor = Math.random() < 0.5 ? 'url(#neonGreen)' : 'url(#neonRed)';
          tailLed.setAttribute('fill', randColor);
        }
      }
    }, 1300 + Math.random() * 1200);
  }
  
  setInterval(() => {
    if (Date.now() - lastMouseMoveTime >= 3000) startIdleEyes();
  }, 1000);

  // 5. Interações com os Campos do Formulário de Login (Password/Mão nos olhos 🙈)
  const passwordInput = document.querySelector('input[type="password"]');
  const otherInputs = document.querySelectorAll('input:not([type="password"])');
  const monkeyElement = document.getElementById('monkey');

  if (passwordInput && monkeyElement) {
    // Quando foca no campo de senha, o macaco cobre os olhos com as mãos cibernéticas (🙈)
    passwordInput.addEventListener('focus', () => {
      isCovering = true;
      monkeyElement.classList.add('monkey-covering');
      showSpeechBubble('SHH! SECUR_KEY');
    });

    passwordInput.addEventListener('blur', () => {
      isCovering = false;
      monkeyElement.classList.remove('monkey-covering');
      if (monkeyPupil) {
        monkeyPupil.style.transform = 'translate(0px, 0px)';
        monkeyPupil.style.opacity = '1';
      }
      visorBack.setAttribute('fill', 'url(#visorGrad)');
      visorBack.setAttribute('filter', 'url(#neonGlow)');
    });
  }

  if (otherInputs && monkeyElement) {
    // Quando foca em outros inputs, o macaco olha curioso
    otherInputs.forEach(input => {
      input.addEventListener('focus', () => {
        if (isCovering) return;
        // Se inclina um pouco e move a pupila para baixo curiosamente
        if (monkeyPupil) monkeyPupil.style.transform = 'translateY(1.8px)';
        showSpeechBubble('SCANNING_USER');
      });
    });
  }

  // 6. Fluxo de Candlesticks (Velas de Gráfico)
  const activeCandles = new Set();
  
  function createCandle() {
    if (activeCandles.size >= 4 || isCovering) return; // Não gera se estiver escondendo os olhos
    
    const isGreen = Math.random() < 0.55;
    const candle = document.createElement('div');
    candle.className = `data-candle ${isGreen ? 'candle-green' : 'candle-red'}`;
    
    const wick = document.createElement('div');
    wick.className = 'candle-wick';
    
    const cBody = document.createElement('div');
    cBody.className = 'candle-body';
    cBody.textContent = isGreen ? '▲' : '▼';
    
    candle.appendChild(wick);
    candle.appendChild(cBody);
    wrapper.appendChild(candle);
    
    const wrapperWidth = wrapper.offsetWidth;
    const x = wrapperWidth + 20;
    const y = 20 + Math.random() * 50; // Passa no nível da cauda/cabeça
    
    candle.style.left = `${x}px`;
    candle.style.top = `${y}px`;
    
    const speed = 2.0 + Math.random() * 2.0;
    
    const candleData = {
      element: candle,
      x: x,
      y: y,
      speed: speed,
      isGreen: isGreen,
      createdAt: Date.now(),
      targetApproached: false
    };
    
    activeCandles.add(candleData);
  }

  function updateCandles() {
    const wrapperWidth = wrapper.offsetWidth;
    
    activeCandles.forEach((candle) => {
      if (candle.x < -40) {
        candle.element.remove();
        activeCandles.delete(candle);
        return;
      }

      // Se a vela estiver na zona de ação do Macaco
      if (!candle.targetApproached && !isHunting && !isCovering) {
        const triggerX = wrapperWidth / 2 - 50;
        
        if (candle.x <= triggerX + 60 && candle.x >= triggerX - 20) {
          candle.targetApproached = true;
          if (candle.isGreen) {
            triggerBuyCapture(candle); // Captura rápida com a cauda preênsil
          } else {
            triggerSellDeflect(candle); // Chicotada de plasma de defesa
          }
        } else {
          candle.x -= candle.speed;
        }
      } else {
        candle.x -= candle.speed;
      }

      candle.element.style.left = `${candle.x}px`;
      candle.element.style.top = `${candle.y}px`;
    });
    
    requestAnimationFrame(updateCandles);
  }

  // Captura de Candlestick Verde (BUY) - Cauda Agarra
  function triggerBuyCapture(candleData) {
    if (isHunting) return;
    isHunting = true;
    
    const candleEl = candleData.element;
    const monkeyEl = document.getElementById('monkey');
    if (!monkeyEl) return;
    
    // LEDs em verde neon
    earLedLeft.setAttribute('fill', 'url(#neonGreen)');
    earLedRight.setAttribute('fill', 'url(#neonGreen)');
    tailLed.setAttribute('fill', 'url(#neonGreen)');
    
    monkeyEl.classList.add('monkey-catching');
    
    // Colisão no pico do movimento (240ms)
    setTimeout(() => {
      candleEl.style.transform = 'scale(0)';
      candleEl.style.opacity = '0';
      
      createSparkExplosion(candleData.x + 8, candleData.y + 12, '#10b981');
      createFloatingTag(candleData.x, candleData.y - 15, 'BUY ORDER', '#10b981');
      showSpeechBubble('BUY_LONG_OK', 'buy');
      
      setTimeout(() => {
        candleEl.remove();
        activeCandles.delete(candleData);
      }, 100);
    }, 240);
    
    // Reset
    setTimeout(() => {
      monkeyEl.classList.remove('monkey-catching');
      isHunting = false;
      earLedLeft.setAttribute('fill', 'url(#visorGrad)');
      earLedRight.setAttribute('fill', 'url(#visorGrad)');
      tailLed.setAttribute('fill', 'url(#visorGrad)');
    }, 580);
  }

  // Defesa de Candlestick Vermelho (SELL) - Cauda Repele
  function triggerSellDeflect(candleData) {
    if (isHunting) return;
    isHunting = true;
    
    const candleEl = candleData.element;
    const monkeyEl = document.getElementById('monkey');
    if (!monkeyEl) return;
    
    // LEDs em vermelho neon
    earLedLeft.setAttribute('fill', 'url(#neonRed)');
    earLedRight.setAttribute('fill', 'url(#neonRed)');
    tailLed.setAttribute('fill', 'url(#neonRed)');
    
    monkeyEl.classList.add('monkey-deflecting');
    
    // Colisão (220ms)
    setTimeout(() => {
      createSparkExplosion(candleData.x + 8, candleData.y + 12, '#f43f5e');
      createFloatingTag(candleData.x, candleData.y - 15, 'SELL ORDER', '#f43f5e');
      showSpeechBubble('SELL_SHORT_OK', 'sell');
      
      candleEl.style.transform = 'translateY(-35px) scale(0)';
      candleEl.style.opacity = '0';
      
      setTimeout(() => {
        candleEl.remove();
        activeCandles.delete(candleData);
      }, 150);
    }, 220);
    
    // Reset
    setTimeout(() => {
      monkeyEl.classList.remove('monkey-deflecting');
      isHunting = false;
      earLedLeft.setAttribute('fill', 'url(#visorGrad)');
      earLedRight.setAttribute('fill', 'url(#visorGrad)');
      tailLed.setAttribute('fill', 'url(#visorGrad)');
    }, 550);
  }

  // Notificação HUD de Terminal
  function showSpeechBubble(text, type = 'log') {
    const oldBubble = mascotContainer.querySelector('.speech-bubble');
    if (oldBubble) oldBubble.remove();

    const bubble = document.createElement('div');
    bubble.className = 'speech-bubble';
    
    if (type === 'buy') {
      bubble.innerHTML = `<span style="color:#10b981;">❯</span> ORDER_FILL: <span style="color:#10b981; font-weight:800;">BUY_LONG_OK</span>`;
    } else if (type === 'sell') {
      bubble.innerHTML = `<span style="color:#f43f5e;">❯</span> ORDER_FILL: <span style="color:#f43f5e; font-weight:800;">SELL_SHORT_OK</span>`;
    } else if (type === 'boost') {
      bubble.innerHTML = `<span style="color:#10b981;">❯</span> SCALING_MAX: <span style="color:#10b981; font-weight:800;">CLIMB_BOOST</span>`;
    } else {
      bubble.innerHTML = `<span style="color:#10b981;">❯</span> MONKEY_LOG: <span style="color:#cbd5e1;">${text}</span>`;
    }
    
    bubble.style.position = 'absolute';
    bubble.style.top = '-20px';
    bubble.style.left = '60%';
    bubble.style.transform = 'translate(-50%, -15px) scale(0.85)';
    bubble.style.opacity = '0';
    bubble.style.background = 'rgba(11, 15, 25, 0.96)';
    bubble.style.border = '1px solid rgba(16, 185, 129, 0.4)';
    bubble.style.color = '#cbd5e1';
    bubble.style.fontSize = '10.5px';
    bubble.style.fontFamily = 'monospace';
    bubble.style.padding = '6px 12px';
    bubble.style.borderRadius = '6px';
    bubble.style.boxShadow = '0 0 20px rgba(16, 185, 129, 0.15), 0 8px 16px rgba(0, 0, 0, 0.6)';
    bubble.style.pointerEvents = 'none';
    bubble.style.whiteSpace = 'nowrap';
    bubble.style.zIndex = '20';
    bubble.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s';
    
    mascotContainer.appendChild(bubble);
    
    setTimeout(() => {
      bubble.style.transform = 'translate(-50%, -5px) scale(1)';
      bubble.style.opacity = '1';
    }, 50);

    setTimeout(() => {
      bubble.style.transform = 'translate(-50%, -15px) scale(0.85)';
      bubble.style.opacity = '0';
      setTimeout(() => bubble.remove(), 220);
    }, 1800);
  }

  // Faíscas neon
  function createSparkExplosion(centerX, centerY, color) {
    for (let i = 0; i < 9; i++) {
      const spark = document.createElement('div');
      spark.style.position = 'absolute';
      spark.style.width = '4px';
      spark.style.height = '4px';
      spark.style.borderRadius = '50%';
      spark.style.background = color;
      spark.style.boxShadow = `0 0 6px ${color}`;
      spark.style.left = `${centerX}px`;
      spark.style.top = `${centerY}px`;
      spark.style.pointerEvents = 'none';
      spark.style.zIndex = '6';
      wrapper.appendChild(spark);
      
      const angle = Math.random() * Math.PI * 2;
      const velocity = 1.2 + Math.random() * 2.8;
      const vx = Math.cos(angle) * velocity;
      const vy = Math.sin(angle) * velocity;
      
      let x = centerX;
      let y = centerY;
      let opacity = 1;
      
      function animateSpark() {
        x += vx;
        y += vy;
        opacity -= 0.05;
        spark.style.left = `${x}px`;
        spark.style.top = `${y}px`;
        spark.style.opacity = opacity;
        
        if (opacity > 0) {
          requestAnimationFrame(animateSpark);
        } else {
          spark.remove();
        }
      }
      requestAnimationFrame(animateSpark);
    }
  }

  // Tag flutuante
  function createFloatingTag(x, y, text, color) {
    const tag = document.createElement('div');
    tag.style.position = 'absolute';
    tag.style.left = `${x - 20}px`;
    tag.style.top = `${y}px`;
    tag.style.color = color;
    tag.style.fontFamily = 'monospace';
    tag.style.fontSize = '9px';
    tag.style.fontWeight = '900';
    tag.style.textShadow = `0 0 6px ${color}`;
    tag.style.pointerEvents = 'none';
    tag.style.zIndex = '6';
    tag.style.transition = 'transform 0.9s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.9s';
    tag.textContent = text;
    wrapper.appendChild(tag);
    
    setTimeout(() => {
      tag.style.transform = 'translateY(-30px) scale(1.15)';
      tag.style.opacity = '0';
    }, 20);
    
    setTimeout(() => tag.remove(), 950);
  }

  // BOOST / Acrobacia de Escalada
  function triggerBoost() {
    if (isHunting || isCovering) return;
    isHunting = true;
    
    const monkeyUpperEl = document.getElementById('monkey-upper');
    if (!monkeyUpperEl) return;
    
    monkeyUpperEl.classList.add('monkey-climbing');
    showSpeechBubble('', 'boost');
    
    // Pisca os LEDs intensamente
    let count = 0;
    const interval = setInterval(() => {
      const activeColor = count % 2 === 0 ? '#34d399' : '#059669';
      earLedLeft.setAttribute('fill', activeColor);
      earLedRight.setAttribute('fill', activeColor);
      tailLed.setAttribute('fill', activeColor);
      count++;
      if (count >= 10) {
        clearInterval(interval);
        earLedLeft.setAttribute('fill', 'url(#visorGrad)');
        earLedRight.setAttribute('fill', 'url(#visorGrad)');
        tailLed.setAttribute('fill', 'url(#visorGrad)');
      }
    }, 70);
    
    // Faíscas de lucro neon
    const rect = mascot.getBoundingClientRect();
    const scaleX = rect.width / 260;
    const scaleY = rect.height / 180;
    const centerGlobalX = rect.left - wrapper.getBoundingClientRect().left + 130 * scaleX;
    const centerGlobalY = rect.top - wrapper.getBoundingClientRect().top + 72 * scaleY;
    createSparkExplosion(centerGlobalX, centerGlobalY, '#10b981');
    
    setTimeout(() => {
      monkeyUpperEl.classList.remove('monkey-climbing');
      isHunting = false;
    }, 720);
  }

  mascotContainer.addEventListener('click', triggerBoost);

  // Inicializa o fluxo
  requestAnimationFrame(updateCandles);
  setInterval(createCandle, 4200);
  createCandle();
});
