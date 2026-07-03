(function () {
  const namespace = "urn:x-cast:com.clipflowy.photoflowy.reader";
  const appName = "Photoflowy";
  const protocolVersion = 1;
  const supportedMessageTypes = [
    "hello",
    "openDeck",
    "frameChunk",
    "showFrame",
    "remoteCommand",
    "setViewportTransform",
    "showPointer",
    "hidePointer",
    "beginHighlightStroke",
    "appendHighlightPoint",
    "endHighlightStroke",
    "replaceHighlightStrokes",
    "clearOverlays",
    "endSession",
  ];
  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const surface = document.getElementById("surface");
  const stateLabel = document.getElementById("stateLabel");
  const detailLabel = document.getElementById("detailLabel");
  const htmlFrame = document.getElementById("htmlFrame");
  const imageFrame = document.getElementById("imageFrame");
  const overlayCanvas = document.getElementById("overlayCanvas");
  const overlayContext = overlayCanvas.getContext("2d");
  const overlaySvg = document.getElementById("overlaySvg");
  const svgNamespace = "http://www.w3.org/2000/svg";
  const chunksByFrame = new Map();
  let sessionId = null;
  let deck = null;
  let viewportTransform = { scale: 1, translateX: 0, translateY: 0 };
  let pointer = null;
  let highlightStrokes = [];
  let currentHighlightStroke = null;

  function setSurface(mode, title, detail) {
    surface.className = `surface surface-${mode}`;
    stateLabel.textContent = title || appName;
    detailLabel.textContent = detail || "";
  }

  function resizeOverlayCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, surface.clientWidth);
    const height = Math.max(1, surface.clientHeight);
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (overlayCanvas.width !== pixelWidth || overlayCanvas.height !== pixelHeight) {
      overlayCanvas.width = pixelWidth;
      overlayCanvas.height = pixelHeight;
    }
    overlayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (overlaySvg) {
      overlaySvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
  }

  function safeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizePoint(source) {
    return {
      x: Math.max(0, Math.min(1, safeNumber(source && source.x, 0))),
      y: Math.max(0, Math.min(1, safeNumber(source && source.y, 0))),
    };
  }

  function normalizeColorHex(value, fallback) {
    const text = String(value || fallback || "#FFFFFF").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback || "#FFFFFF";
  }

  function transformedPoint(point) {
    const width = Math.max(1, surface.clientWidth);
    const height = Math.max(1, surface.clientHeight);
    return {
      x:
        point.x * width * viewportTransform.scale +
        viewportTransform.translateX * width,
      y:
        point.y * height * viewportTransform.scale +
        viewportTransform.translateY * height,
    };
  }

  function clearSvgOverlay() {
    if (!overlaySvg) return;
    while (overlaySvg.firstChild) {
      overlaySvg.removeChild(overlaySvg.firstChild);
    }
  }

  function appendSvgElement(name, attributes) {
    if (!overlaySvg) return null;
    const element = document.createElementNS(svgNamespace, name);
    Object.entries(attributes).forEach(([key, value]) => {
      element.setAttribute(key, String(value));
    });
    overlaySvg.appendChild(element);
    return element;
  }

  function drawSvgOverlay(width, height) {
    clearSvgOverlay();
    if (!overlaySvg) return;
    overlaySvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    highlightStrokes.forEach((stroke) => {
      if (!stroke.points || stroke.points.length === 0) return;
      const color = normalizeColorHex(stroke.colorHex, "#FFF176");
      const strokeWidth = safeNumber(stroke.width, 10);
      if (stroke.points.length === 1) {
        const center = transformedPoint(stroke.points[0]);
        appendSvgElement("circle", {
          cx: center.x,
          cy: center.y,
          r: strokeWidth / 2,
          fill: color,
          opacity: "0.55",
        });
        return;
      }
      const points = stroke.points
        .map((point) => {
          const transformed = transformedPoint(point);
          return `${transformed.x},${transformed.y}`;
        })
        .join(" ");
      appendSvgElement("polyline", {
        points,
        fill: "none",
        stroke: color,
        "stroke-width": strokeWidth,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        opacity: "0.55",
      });
    });

    if (pointer) {
      const center = transformedPoint(pointer);
      const color = normalizeColorHex(pointer.colorHex, "#EF4444");
      appendSvgElement("circle", {
        cx: center.x,
        cy: center.y,
        r: 18,
        fill: color,
        opacity: "0.24",
      });
      appendSvgElement("circle", {
        cx: center.x,
        cy: center.y,
        r: 7,
        fill: color,
        opacity: "0.86",
      });
    }
  }

  function drawOverlay() {
    resizeOverlayCanvas();
    const width = Math.max(1, surface.clientWidth);
    const height = Math.max(1, surface.clientHeight);
    overlayContext.clearRect(0, 0, width, height);

    highlightStrokes.forEach((stroke) => {
      if (!stroke.points || stroke.points.length === 0) return;
      overlayContext.save();
      overlayContext.globalAlpha = 0.55;
      overlayContext.strokeStyle = normalizeColorHex(stroke.colorHex, "#FFF176");
      overlayContext.fillStyle = normalizeColorHex(stroke.colorHex, "#FFF176");
      overlayContext.lineWidth = safeNumber(stroke.width, 10);
      overlayContext.lineCap = "round";
      overlayContext.lineJoin = "round";
      const first = transformedPoint(stroke.points[0]);
      if (stroke.points.length === 1) {
        overlayContext.beginPath();
        overlayContext.arc(first.x, first.y, overlayContext.lineWidth / 2, 0, Math.PI * 2);
        overlayContext.fill();
        overlayContext.restore();
        return;
      }
      overlayContext.beginPath();
      overlayContext.moveTo(first.x, first.y);
      stroke.points.slice(1).forEach((point) => {
        const next = transformedPoint(point);
        overlayContext.lineTo(next.x, next.y);
      });
      overlayContext.stroke();
      overlayContext.restore();
    });

    if (pointer) {
      const center = transformedPoint(pointer);
      const color = normalizeColorHex(pointer.colorHex, "#EF4444");
      overlayContext.save();
      overlayContext.fillStyle = color;
      overlayContext.globalAlpha = 0.24;
      overlayContext.beginPath();
      overlayContext.arc(center.x, center.y, 18, 0, Math.PI * 2);
      overlayContext.fill();
      overlayContext.globalAlpha = 0.86;
      overlayContext.beginPath();
      overlayContext.arc(center.x, center.y, 7, 0, Math.PI * 2);
      overlayContext.fill();
      overlayContext.restore();
    }
    drawSvgOverlay(width, height);
  }

  function applyViewportTransform(transform) {
    viewportTransform = {
      scale: Math.max(1, Math.min(4, safeNumber(transform && transform.scale, 1))),
      translateX: safeNumber(transform && transform.translateX, 0),
      translateY: safeNumber(transform && transform.translateY, 0),
    };
    const tx = viewportTransform.translateX * Math.max(1, surface.clientWidth);
    const ty = viewportTransform.translateY * Math.max(1, surface.clientHeight);
    const css = `translate(${tx}px, ${ty}px) scale(${viewportTransform.scale})`;
    htmlFrame.style.transform = css;
    imageFrame.style.transform = css;
    drawOverlay();
  }

  function clearOverlays(resetTransform) {
    pointer = null;
    highlightStrokes = [];
    currentHighlightStroke = null;
    if (resetTransform) {
      applyViewportTransform({ scale: 1, translateX: 0, translateY: 0 });
      return;
    }
    drawOverlay();
  }

  function send(senderId, type, requestId, payload) {
    context.sendCustomMessage(namespace, senderId, {
      type,
      requestId: `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionId,
      payload: {
        ...(payload || {}),
        ...(requestId ? { ackRequestId: requestId } : {}),
      },
    });
  }

  function ack(senderId, message, extra) {
    send(senderId, "ack", message.requestId, extra);
  }

  function reportState(senderId, state, frameId) {
    send(senderId, "state", null, { state, frameId });
  }

  function reportError(senderId, requestId, code, message) {
    send(senderId, "error", requestId, {
      code,
      message,
      recoverable: true,
    });
    setSurface("error", "Cast error", message);
  }

  function decodeFrame(frameId) {
    const record = chunksByFrame.get(frameId);
    if (!record || record.parts.some((part) => typeof part !== "string")) {
      throw new Error("Frame chunks are incomplete.");
    }
    const encoded = record.parts.join("");
    const json = decodeURIComponent(
      Array.prototype.map
        .call(atob(encoded), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("")
    );
    return JSON.parse(json);
  }

  function showFrame(senderId, message) {
    const frameId = message.payload && message.payload.frameId;
    if (!frameId) {
      reportError(senderId, message.requestId, "frameTransferFailed", "frameId is required.");
      return;
    }
    let frame;
    try {
      frame = decodeFrame(frameId);
    } catch (error) {
      reportError(senderId, message.requestId, "frameTransferFailed", String(error.message || error));
      return;
    }

    imageFrame.removeAttribute("src");
    htmlFrame.removeAttribute("srcdoc");
    clearOverlays(true);

    if (frame.contentType && frame.contentType.startsWith("image/")) {
      imageFrame.src = `data:${frame.contentType};base64,${frame.payload}`;
      imageFrame.alt = frame.displayName || "";
      setSurface("image", "", "");
    } else if (frame.contentType && frame.contentType.startsWith("text/html")) {
      htmlFrame.srcdoc = frame.payload || "";
      setSurface("html", "", "");
    } else {
      const payload = safeJson(frame.payload);
      setSurface(
        "error",
        frame.displayName || "Unsupported frame",
        payload.message || "This item cannot be shown on Cast."
      );
    }
    chunksByFrame.delete(frameId);
    ack(senderId, message, { frameId });
    reportState(senderId, "showing", frameId);
  }

  function safeJson(source) {
    try {
      return JSON.parse(source || "{}");
    } catch (_) {
      return {};
    }
  }

  function parseMessageData(data) {
    if (typeof data === "string") {
      return safeJson(data);
    }
    if (data && typeof data === "object") {
      return data;
    }
    return {};
  }

  context.addCustomMessageListener(namespace, function (event) {
    const senderId = event.senderId;
    const message = parseMessageData(event.data);
    const payload = message.payload || {};
    sessionId = message.sessionId || sessionId;

    switch (message.type) {
      case "hello":
        ack(senderId, message, {
          protocolVersion,
          supportedMessageTypes,
          overlay: true,
        });
        reportState(senderId, "ready");
        break;
      case "openDeck":
        deck = payload;
        chunksByFrame.clear();
        clearOverlays(true);
        setSurface("loading", deck.title || appName, "Preparing Cast receiver...");
        ack(senderId, message, { deckId: deck.deckId });
        reportState(senderId, "loading");
        break;
      case "frameChunk": {
        const frameId = payload.frameId;
        const chunkIndex = Number(payload.chunkIndex);
        const chunkCount = Number(payload.chunkCount);
        if (!frameId || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount)) {
          reportError(senderId, message.requestId, "frameTransferFailed", "Invalid frame chunk.");
          return;
        }
        const record = chunksByFrame.get(frameId) || {
          parts: new Array(chunkCount),
        };
        record.parts[chunkIndex] = String(payload.payloadChunk || "");
        chunksByFrame.set(frameId, record);
        ack(senderId, message, { frameId, chunkIndex });
        break;
      }
      case "showFrame":
        showFrame(senderId, message);
        break;
      case "remoteCommand":
        if (payload.command === "close") {
          chunksByFrame.clear();
          clearOverlays(true);
          setSurface("idle", appName, "Cast session closed.");
          reportState(senderId, "closed");
        }
        ack(senderId, message, { command: payload.command });
        break;
      case "setViewportTransform":
        applyViewportTransform(payload);
        ack(senderId, message);
        break;
      case "showPointer":
        pointer = {
          ...normalizePoint(payload),
          colorHex: normalizeColorHex(payload.colorHex, "#EF4444"),
        };
        drawOverlay();
        ack(senderId, message);
        break;
      case "hidePointer":
        pointer = null;
        drawOverlay();
        ack(senderId, message);
        break;
      case "beginHighlightStroke":
        currentHighlightStroke = {
          colorHex: normalizeColorHex(payload.colorHex, "#FFF176"),
          width: Math.max(1, safeNumber(payload.width, 10)),
          points: [normalizePoint(payload)],
        };
        highlightStrokes.push(currentHighlightStroke);
        drawOverlay();
        ack(senderId, message);
        break;
      case "appendHighlightPoint":
        if (currentHighlightStroke) {
          currentHighlightStroke.points.push(normalizePoint(payload));
          drawOverlay();
        }
        ack(senderId, message);
        break;
      case "endHighlightStroke":
        currentHighlightStroke = null;
        ack(senderId, message);
        break;
      case "replaceHighlightStrokes":
        highlightStrokes = Array.isArray(payload.strokes)
          ? payload.strokes.map((stroke) => ({
              colorHex: normalizeColorHex(stroke && stroke.colorHex, "#FFF176"),
              width: Math.max(1, safeNumber(stroke && stroke.width, 10)),
              points: Array.isArray(stroke && stroke.points)
                ? stroke.points.map(normalizePoint)
                : [],
            }))
          : [];
        currentHighlightStroke = null;
        drawOverlay();
        ack(senderId, message);
        break;
      case "clearOverlays":
        clearOverlays(true);
        ack(senderId, message);
        break;
      case "endSession":
        chunksByFrame.clear();
        clearOverlays(true);
        setSurface("idle", appName, "Waiting for content...");
        ack(senderId, message);
        reportState(senderId, "closed");
        break;
      default:
        reportError(senderId, message.requestId, "frameTransferFailed", "Unknown message type.");
    }
  });

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (loadRequestData) {
      imageFrame.removeAttribute("src");
      htmlFrame.removeAttribute("srcdoc");
      const metadata = loadRequestData.media && loadRequestData.media.metadata;
      const title = metadata && metadata.title ? metadata.title : "Read-aloud audio";
      const subtitle = metadata && metadata.subtitle ? metadata.subtitle : appName;
      setSurface("audio", title, subtitle);
      return loadRequestData;
    }
  );

  window.addEventListener("resize", drawOverlay);
  imageFrame.addEventListener("load", drawOverlay);
  htmlFrame.addEventListener("load", drawOverlay);
  resizeOverlayCanvas();
  setSurface("idle", appName, "Waiting for content...");
  context.start({
    disableIdleTimeout: true,
  });
})();
