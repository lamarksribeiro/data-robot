/**
 * Mascote Interativo de Login - Data Fox (Versão Cibernética Geométrica Premium)
 * Encapsula de forma limpa e isolada todos os estilos, HTML e comportamentos do mascote.
 */

document.addEventListener('DOMContentLoaded', () => {
  const loginCard = document.querySelector('.login');
  if (!loginCard) return;

  // 1. Injetar Estilos CSS do Mascote e Candlesticks
  const style = document.createElement('style');
  style.textContent = `
    /* Estilos do Mascote Interativo (Raposa de Trading) */
    .login-wrapper {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-top: 110px; /* Dá espaço generoso para a raposa acima */
      margin-bottom: 20px;
      width: 100%;
      position: relative;
    }
    
    .mascot-container {
      width: 260px;
      height: 180px;
      position: absolute;
      top: -142px; /* Encaixa as patas perfeitamente no topo do card */
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

    /* Respiração da Raposa (balanço sutil de tronco e cabeça) */
    @keyframes foxBreathing {
      0%, 100% { transform: translateY(0px) scaleY(1); }
      50% { transform: translateY(-2.5px) scaleY(0.98); }
    }
    
    #fox-upper {
      animation: foxBreathing 4.5s ease-in-out infinite;
      transform-origin: 130px 145px; /* Conexão com as patas */
    }

    /* Cauda balançando suavemente */
    @keyframes tailWiggleFox {
      0%, 100% { transform: rotate(0deg) translateY(0); }
      50% { transform: rotate(-3deg) translateY(-1.5px); }
    }
    #fox-tail {
      animation: tailWiggleFox 5s ease-in-out infinite;
      transform-origin: 168px 125px;
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* Orelhas mexendo de leve estilo antena radar */
    @keyframes earMoveRight {
      0%, 90%, 100% { transform: rotate(0deg); }
      93%, 97% { transform: rotate(-2deg); }
    }
    @keyframes earMoveLeft {
      0%, 88%, 100% { transform: rotate(0deg); }
      91%, 95% { transform: rotate(3deg); }
    }
    #ear-right {
      animation: earMoveRight 6s ease-in-out infinite;
      transform-origin: 115px 56px;
      transition: transform 0.3s ease;
    }
    #ear-left {
      animation: earMoveLeft 6s ease-in-out infinite;
      transform-origin: 98px 58px;
      transition: transform 0.3s ease;
    }

    /* Mordida Rápida de Caça (Fox Bite) */
    @keyframes foxBite {
      0% { transform: translate(0px, 0px) rotate(0deg); }
      15% { transform: translate(-8px, -4px) rotate(-4deg); }
      30% { transform: translate(-28px, 12px) rotate(8deg); }
      45% { transform: translate(-30px, 14px) rotate(8deg) scaleY(1.02); }
      75% { transform: translate(4px, -2px) rotate(-2deg); }
      100% { transform: translate(0px, 0px) rotate(0deg); }
    }
    .fox-biting {
      animation: foxBite 0.52s cubic-bezier(0.25, 1, 0.5, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Defesa / Chicotada com a Cauda (Fox Deflect) */
    @keyframes tailDeflect {
      0% { transform: rotate(0deg); }
      20% { transform: rotate(12deg) scale(0.95); }
      45% { transform: rotate(-28deg) translate(-15px, -8px) scale(1.05); }
      75% { transform: rotate(4deg) translate(2px, 1px); }
      100% { transform: rotate(0deg); }
    }
    .fox-deflecting #fox-tail {
      animation: none !important;
      animation: tailDeflect 0.55s cubic-bezier(0.16, 1, 0.3, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Animação de Comemoração / BOOST */
    @keyframes foxBoostAnimation {
      0% { transform: scale(1) rotate(0deg); }
      25% { transform: scale(0.92) translateY(5px) rotate(-6deg); }
      55% { transform: scale(1.1) translateY(-14px) rotate(10deg); }
      80% { transform: scale(0.97) translateY(1px) rotate(-2deg); }
      100% { transform: scale(1) rotate(0deg); }
    }
    .fox-boosting {
      animation: foxBoostAnimation 0.65s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
      animation-fill-mode: forwards;
    }

    /* Animação quando foca no campo de senha (Cobre o rosto com a cauda de forma fofa) */
    .fox-covering #fox-tail {
      animation: none !important;
      transform: translate(-115px, -18px) rotate(-62deg) scale(1.15) !important;
    }
    
    .fox-covering #ear-right {
      transform: rotate(-10deg) translateY(2px) !important;
    }
    .fox-covering #ear-left {
      transform: rotate(8deg) translateY(2px) !important;
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

  // 3. Criar e injetar o SVG da Raposa de Trading Cibernética (Data Fox - Versão Detalhada com Olhos Normais)
  const mascotContainer = document.createElement('div');
  mascotContainer.className = 'mascot-container';
  mascotContainer.innerHTML = `
    <svg id="mascot" width="260" height="180" viewBox="0 0 260 180" style="overflow: visible;">
      <defs>
        <!-- Gradiente Metálico Prateado/Cinza Espacial para o Corpo -->
        <linearGradient id="cobreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#94a3b8" /> <!-- Prata brilhante -->
          <stop offset="60%" stop-color="#475569" /> <!-- Cinza Metálico -->
          <stop offset="100%" stop-color="#1e293b" /> <!-- Cinza Escuro Grafite -->
        </linearGradient>

        <!-- Gradiente Metalizado Escuro (Detalhes/Costas) -->
        <linearGradient id="darkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#334155" />
          <stop offset="100%" stop-color="#0f172a" />
        </linearGradient>

        <!-- Gradiente Creme do Peito -->
        <linearGradient id="cremeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#f8fafc" />
          <stop offset="100%" stop-color="#cbd5e1" />
        </linearGradient>

        <!-- Gradiente Neon Verde para Cauda e Visor (BUY) -->
        <linearGradient id="neonGreen" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#10b981" />
          <stop offset="100%" stop-color="#047857" />
        </linearGradient>

        <!-- Gradiente Neon Vermelho para Cauda e Visor (SELL) -->
        <linearGradient id="neonRed" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f43f5e" />
          <stop offset="100%" stop-color="#be123c" />
        </linearGradient>

        <!-- Gradiente Amarelo Neon para o Visor -->
        <linearGradient id="visorGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#facc15" />
          <stop offset="100%" stop-color="#eab308" />
        </linearGradient>

        <!-- Filtro Glow para Painéis Neon -->
        <filter id="neonGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <!-- Grupo da Raposa -->
      <g id="fox" style="transform-origin: 130px 145px;">
        <!-- Sombra de contato -->
        <ellipse cx="130" cy="142" rx="48" ry="3.5" fill="#000000" opacity="0.45" />

        <!-- Pernas e Patas Estáticas -->
        <g id="legs">
          <!-- Patas Traseiras (Dobrada na base) -->
          <ellipse cx="144" cy="132" rx="14" ry="10" fill="url(#cobreGrad)" stroke="#1e293b" stroke-width="1.2" style="transform: rotate(-10deg); transform-origin: 144px 132px;" />
          <ellipse cx="148" cy="142" rx="8" ry="2.5" fill="url(#cobreGrad)" stroke="#1e293b" stroke-width="1.2" />
          
          <!-- Pata Dianteira Esquerda (Atrás) -->
          <path d="M 106,120 L 102,142" fill="none" stroke="#1e293b" stroke-width="5" stroke-linecap="round" opacity="0.6" />
          <ellipse cx="102" cy="142" rx="4" ry="2" fill="#1e293b" opacity="0.6" />

          <!-- Pata Dianteira Direita (Frente) -->
          <path d="M 116,118 L 112,142" fill="none" stroke="url(#cobreGrad)" stroke-width="5.5" stroke-linecap="round" />
          <ellipse cx="112" cy="142" rx="4.5" ry="2.2" fill="url(#cobreGrad)" stroke="#1e293b" stroke-width="0.8" />
        </g>

        <!-- Grupo Superior (Sofre Respiração e Rotação) -->
        <g id="fox-upper">
          
          <!-- Cauda de Raposa horizontal e peluda, com ponta branca (Sem parecer esquilo) -->
          <g id="fox-tail" style="transform-origin: 154px 128px;">
            <!-- Base e meio da cauda (Prata) -->
            <path d="M 152,126 Q 190,118 212,130 L 206,142 Q 180,144 154,136 Z" fill="url(#cobreGrad)" stroke="#1e293b" stroke-width="1.5" stroke-linejoin="round" />
            <!-- Faceta Superior da Cauda (Elemento Neon/Creme Dinâmico) -->
            <path id="tail-facet-top" d="M 190,118 Q 201,124 212,130 L 206,142 Q 195,133 190,118" fill="url(#cremeGrad)" opacity="0.15" stroke="#1e293b" stroke-width="0.8" />
            <!-- Ponta da cauda (Creme/Branca) -->
            <path id="tail-facet-bottom" d="M 212,130 Q 228,124 240,135 Q 223,146 206,142 Z" fill="url(#cremeGrad)" stroke="#cbd5e1" stroke-width="1.5" stroke-linejoin="round" />
          </g>

          <!-- Corpo Principal Simples Low-Poly -->
          <polygon id="fox-body" points="104,115 130,96 164,110 156,142 114,142 94,120" fill="url(#cobreGrad)" stroke="#1e293b" stroke-width="1.5" stroke-linejoin="round" />
          
          <!-- Facetas Geométricas do corpo para estilo premium -->
          <polygon points="104,115 130,96 148,106 122,124" fill="#ffffff" opacity="0.08" />
          <polygon points="122,124 148,106 164,110 156,142 134,142" fill="#000000" opacity="0.12" />

          <!-- Peito Creme Fofo -->
          <polygon points="104,115 130,96 126,138 114,142" fill="url(#cremeGrad)" stroke="#cbd5e1" stroke-width="1.2" stroke-linejoin="round" />

          <!-- Cabeça da Raposa de Perfil (Voltada para a esquerda) -->
          <g id="fox-head" style="transform-origin: 124px 85px;">
            <!-- Face Superior, Focinho e Bochechas -->
            <polygon points="126,86 116,56 86,60 62,80 50,88 72,96 102,96 126,90" fill="url(#cobreGrad)" stroke="#1e293b" stroke-width="1.5" stroke-linejoin="round" />
            
            <!-- Facetas Geométricas da cabeça -->
            <polygon points="116,56 86,60 62,80 88,76" fill="#ffffff" opacity="0.08" />
            
            <!-- Bochecha Creme -->
            <polygon points="62,80 50,88 72,96 86,96" fill="url(#cremeGrad)" stroke="#cbd5e1" stroke-width="1" stroke-linejoin="round" />
            <polygon points="72,96 86,96 102,96 88,86" fill="#000000" opacity="0.1" />

            <!-- Nariz Preto Fofo -->
            <circle cx="50" cy="88" r="2.8" fill="#111827" />

            <!-- Orelha Esquerda (Traseira) -->
            <polygon id="ear-left" points="94,58 76,22 88,18 100,50" fill="#1e293b" opacity="0.7" />

            <!-- Orelha Direita (Dianteira) -->
            <g id="ear-right-group">
              <polygon id="ear-right" points="112,56 94,14 108,8 120,46" fill="url(#cobreGrad)" stroke="#1e293b" stroke-width="1.5" stroke-linejoin="round" />
              <polygon points="100,20 106,15 110,32" id="ear-led" fill="url(#visorGrad)" opacity="0.75" />
            </g>

            <!-- Olhos Normais de Cartoon (Padrão Gecko/Runner) -->
            <ellipse cx="65" cy="74" rx="4.5" ry="7.5" fill="#ffffff" stroke="#1e293b" stroke-width="1.2" />
            <ellipse cx="73.5" cy="73" rx="4.5" ry="7.5" fill="#ffffff" stroke="#1e293b" stroke-width="1.2" />

            <!-- Pupilas que reagem ao mouse -->
            <g id="fox-pupil" style="transition: transform 0.12s ease-out;">
              <ellipse cx="65.5" cy="74.5" rx="1.8" ry="3.0" fill="#000000" />
              <circle cx="64.9" cy="73.3" r="0.6" fill="#ffffff" />
              <ellipse cx="74.0" cy="73.5" rx="1.8" ry="3.0" fill="#000000" />
              <circle cx="73.4" cy="72.3" r="0.6" fill="#ffffff" />
            </g>

            <!-- Boca Fofa -->
            <path d="M 50,90 Q 55,92 60,90" fill="none" stroke="#1e293b" stroke-width="1.2" stroke-linecap="round" />
          </g>

        </g>
      </g>
    </svg>
  `;
  wrapper.insertBefore(mascotContainer, loginCard);

  // 4. Lógica Ocular, Reações a Campos de Login e Caça a Candles
  const mascot = document.getElementById('mascot');
  const foxPupil = document.getElementById('fox-pupil');
  const foxUpper = document.getElementById('fox-upper');
  
  const earLed = document.getElementById('ear-led');
  const tailFacetTop = document.getElementById('tail-facet-top');
  const tailFacetBottom = document.getElementById('tail-facet-bottom');
  
  let isHunting = false;
  let isCovering = false;
  let lastMouseMoveTime = Date.now();
  let idleEyeTimer = null;

  // Atualização das pupilas com base no mouse (coordenada central aproximada X=69, Y=74 na cabeça)
  function updatePupil(targetX, targetY) {
    if (!foxPupil || !mascot || isHunting || isCovering) return;
    
    const rect = mascot.getBoundingClientRect();
    const scaleX = rect.width / 260;
    const scaleY = rect.height / 180;
    
    const eyeCenterX = rect.left + 69 * scaleX;
    const eyeCenterY = rect.top + 74 * scaleY;
    
    const dx = targetX - eyeCenterX;
    const dy = targetY - eyeCenterY;
    const distance = Math.hypot(dx, dy);
    
    const maxOffset = 2.2;
    const intensity = Math.min(distance / 200, 1);
    const angle = Math.atan2(dy, dx);
    
    foxPupil.style.transform = `translate(${Math.cos(angle) * maxOffset * intensity}px, ${Math.sin(angle) * maxOffset * intensity}px)`;
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
      const offset = Math.random() * 2.2;
      
      if (foxPupil) {
        foxPupil.style.transform = `translate(${Math.cos(angle) * offset}px, ${Math.sin(angle) * offset}px)`;
        if (Math.random() < 0.25) {
          tailFacetTop.setAttribute('fill', Math.random() < 0.5 ? 'url(#neonGreen)' : 'url(#neonRed)');
        }
      }
    }, 1200 + Math.random() * 1200);
  }
  
  setInterval(() => {
    if (Date.now() - lastMouseMoveTime >= 3000) startIdleEyes();
  }, 1000);

  // 5. Interações fofas com os Campos do Formulário de Login (Password Coverage)
  const passwordInput = document.querySelector('input[type="password"]');
  const otherInputs = document.querySelectorAll('input:not([type="password"])');
  const foxElement = document.getElementById('fox');

  if (passwordInput && foxElement) {
    // Quando foca no campo de senha, a raposa cobre a cabeça com a cauda
    passwordInput.addEventListener('focus', () => {
      isCovering = true;
      foxElement.classList.add('fox-covering');
      // Fecha as pupilas/olhos
      if (foxPupil) foxPupil.style.transform = 'translate(-3px, 2px) scaleY(0.1)';
      showSpeechBubble('SHH! PASSWORD_KEY');
    });

    passwordInput.addEventListener('blur', () => {
      isCovering = false;
      foxElement.classList.remove('fox-covering');
      if (foxPupil) foxPupil.style.transform = 'translate(0px, 0px)';
    });
  }

  if (otherInputs && foxElement) {
    // Quando foca em outros inputs, a raposa olha curiosa
    otherInputs.forEach(input => {
      input.addEventListener('focus', () => {
        if (isCovering) return;
        // Move o olho para frente
        if (foxPupil) foxPupil.style.transform = 'translate(-1.8px, 0.5px)';
        showSpeechBubble('SCANNING_USER');
      });
    });
  }

  // 6. Fluxo de Candlesticks (Velas de Gráfico)
  const activeCandles = new Set();
  
  function createCandle() {
    if (activeCandles.size >= 4 || isCovering) return; // Não gera candles se estiver escondendo a senha
    
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
    const y = 20 + Math.random() * 50; // Passa no nível da cabeça/visor
    
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

      // Se a vela estiver na zona de ação da Raposa (X central é 50%)
      if (!candle.targetApproached && !isHunting && !isCovering) {
        const triggerX = wrapperWidth / 2 - 50;
        
        if (candle.x <= triggerX + 40 && candle.x >= triggerX - 40) {
          candle.targetApproached = true;
          if (candle.isGreen) {
            triggerBuyCapture(candle); // Mordida rápida de plasma
          } else {
            triggerSellDeflect(candle); // Chicotada com a cauda
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

  // Captura de Candlestick Verde (BUY) - Mordida
  function triggerBuyCapture(candleData) {
    if (isHunting) return;
    isHunting = true;
    
    const candleEl = candleData.element;
    const upperEl = document.getElementById('fox-upper');
    if (!upperEl) return;
    
    // LEDs em verde
    earLed.setAttribute('fill', 'url(#neonGreen)');
    tailFacetTop.setAttribute('fill', 'url(#neonGreen)');
    
    upperEl.classList.add('fox-biting');
    
    // Colisão no pico da mordida (200ms)
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
    }, 200);
    
    // Reset
    setTimeout(() => {
      upperEl.classList.remove('fox-biting');
      isHunting = false;
      earLed.setAttribute('fill', 'url(#visorGrad)');
      tailFacetTop.setAttribute('fill', 'url(#neonGreen)');
    }, 550);
  }

  // Defesa de Candlestick Vermelho (SELL) - Cauda
  function triggerSellDeflect(candleData) {
    if (isHunting) return;
    isHunting = true;
    
    const candleEl = candleData.element;
    const foxEl = document.getElementById('fox');
    if (!foxEl) return;
    
    // LEDs em vermelho neon
    earLed.setAttribute('fill', 'url(#neonRed)');
    tailFacetTop.setAttribute('fill', 'url(#neonRed)');
    
    foxEl.classList.add('fox-deflecting');
    
    // Colisão na chicotada (240ms)
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
    }, 240);
    
    // Reset
    setTimeout(() => {
      foxEl.classList.remove('fox-deflecting');
      isHunting = false;
      earLed.setAttribute('fill', 'url(#visorGrad)');
      tailFacetTop.setAttribute('fill', 'url(#neonGreen)');
    }, 580);
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
      bubble.innerHTML = `<span style="color:#facc15;">❯</span> ENGINE_BOOST: <span style="color:#facc15; font-weight:800;">DATA_FOX_MAX</span>`;
    } else {
      bubble.innerHTML = `<span style="color:#facc15;">❯</span> FOX_LOG: <span style="color:#cbd5e1;">${text}</span>`;
    }
    
    bubble.style.position = 'absolute';
    bubble.style.top = '-20px';
    bubble.style.left = '60%';
    bubble.style.transform = 'translate(-50%, -15px) scale(0.85)';
    bubble.style.opacity = '0';
    bubble.style.background = 'rgba(11, 15, 25, 0.96)';
    bubble.style.border = '1px solid rgba(250, 204, 21, 0.4)';
    bubble.style.color = '#cbd5e1';
    bubble.style.fontSize = '10.5px';
    bubble.style.fontFamily = 'monospace';
    bubble.style.padding = '6px 12px';
    bubble.style.borderRadius = '6px';
    bubble.style.boxShadow = '0 0 20px rgba(250, 204, 21, 0.15), 0 8px 16px rgba(0, 0, 0, 0.6)';
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

  // BOOST
  function triggerBoost() {
    if (isHunting || isCovering) return;
    isHunting = true;
    
    const foxUpperEl = document.getElementById('fox-upper');
    if (!foxUpperEl) return;
    
    foxUpperEl.classList.add('fox-boosting');
    showSpeechBubble('', 'boost');
    
    // Pisca os LEDs intensamente
    let count = 0;
    const interval = setInterval(() => {
      const activeColor = count % 2 === 0 ? '#10b981' : '#f43f5e';
      earLed.setAttribute('fill', activeColor);
      tailFacetTop.setAttribute('fill', activeColor);
      count++;
      if (count >= 10) {
        clearInterval(interval);
        earLed.setAttribute('fill', 'url(#visorGrad)');
        tailFacetTop.setAttribute('fill', 'url(#neonGreen)');
      }
    }, 70);
    
    // Faíscas
    const rect = mascot.getBoundingClientRect();
    const scaleX = rect.width / 260;
    const scaleY = rect.height / 180;
    const centerGlobalX = rect.left - wrapper.getBoundingClientRect().left + 130 * scaleX;
    const centerGlobalY = rect.top - wrapper.getBoundingClientRect().top + 120 * scaleY;
    createSparkExplosion(centerGlobalX, centerGlobalY, '#facc15');
    
    setTimeout(() => {
      foxUpperEl.classList.remove('fox-boosting');
      isHunting = false;
    }, 650);
  }

  mascotContainer.addEventListener('click', triggerBoost);

  // Inicializa o fluxo
  requestAnimationFrame(updateCandles);
  setInterval(createCandle, 4200);
  createCandle();
});
