export function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(input)));
}

export function withPluginPath(config, pluginPath) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("OpenCode config must be an object");
  }
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    throw new TypeError("OpenCode config plugin must be an array");
  }
  const plugins = [...(config.plugin ?? [])];
  if (plugins.some((entry) => typeof entry !== "string")) {
    throw new TypeError("OpenCode config plugin array must contain only strings");
  }
  if (!plugins.includes(pluginPath)) plugins.push(pluginPath);
  return { ...config, plugin: plugins };
}

export async function installOpenCodePlugin({
  configPath,
  configDirectory,
  pluginPath,
  readFile,
  writeFile,
  mkdir
}) {
  let config = {};
  let source = null;
  try {
    source = await readFile(configPath, "utf8");
    config = parseJsonc(source);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const updated = withPluginPath(config, pluginPath);
  const changed = JSON.stringify(updated) !== JSON.stringify(config);
  await mkdir(configDirectory, { recursive: true });
  if (changed) {
    const nextSource = source === null
      ? `${JSON.stringify(updated, null, 2)}\n`
      : updatePluginInJsonc(source, updated.plugin);
    await writeFile(configPath, nextSource);
  }
  return { configPath, changed };
}

function updatePluginInJsonc(source, plugins) {
  const tokens = tokenizeJsonc(source);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const rootOpen = tokens.findIndex((token) => token.type === "{");
  if (rootOpen === -1) throw new SyntaxError("OpenCode config must be a JSON object");

  let objectDepth = 0;
  let arrayDepth = 0;
  const pluginProperties = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "{") objectDepth += 1;
    else if (token.type === "}") objectDepth -= 1;
    else if (token.type === "[") arrayDepth += 1;
    else if (token.type === "]") arrayDepth -= 1;
    else if (
      token.type === "string"
      && token.value === "plugin"
      && objectDepth === 1
      && arrayDepth === 0
      && tokens[index + 1]?.type === ":"
    ) {
      const openIndex = index + 2;
      const closeIndex = tokens[openIndex]?.type === "[" ? matchingArrayClose(tokens, openIndex) : null;
      pluginProperties.push({ keyIndex: index, openIndex, closeIndex });
    }
  }

  if (pluginProperties.length > 1) {
    throw new SyntaxError("OpenCode config contains duplicate plugin keys");
  }
  if (pluginProperties.length === 1) {
    const [{ keyIndex, openIndex, closeIndex }] = pluginProperties;
    if (closeIndex === null) throw new TypeError("OpenCode config plugin must be an array");
    const indent = lineIndentAt(source, tokens[keyIndex].start);
    return appendPluginArrayEntry(
      source,
      tokens,
      openIndex,
      closeIndex,
      plugins.at(-1),
      `${indent}  `,
      indent,
      newline
    );
  }

  return appendRootPlugin(source, tokens, plugins);
}

function appendPluginArrayEntry(source, tokens, openIndex, closeIndex, pluginPath, elementIndent, closingIndent, newline) {
  const elementTokenIndexes = [];
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    if (tokens[index].type === "string") elementTokenIndexes.push(index);
  }

  let updated = source;
  let closeStart = tokens[closeIndex].start;
  let preserveTrailingComma = false;
  const lastElementIndex = elementTokenIndexes.at(-1);
  if (lastElementIndex !== undefined) {
    preserveTrailingComma = tokens
      .slice(lastElementIndex + 1, closeIndex)
      .some((token) => token.type === ",");
    if (!preserveTrailingComma) {
      const insertionPoint = tokens[lastElementIndex].end;
      updated = `${updated.slice(0, insertionPoint)},${updated.slice(insertionPoint)}`;
      closeStart += 1;
    }
  }

  const closeLineStart = updated.lastIndexOf("\n", closeStart - 1) + 1;
  const closeHasOwnLine = /^\s*$/u.test(updated.slice(closeLineStart, closeStart));
  const insertionPoint = closeHasOwnLine ? closeLineStart : closeStart;
  const before = updated.slice(0, insertionPoint);
  const prefix = before.endsWith("\n") ? "" : newline;
  const entry = `${elementIndent}${JSON.stringify(pluginPath)}${preserveTrailingComma ? "," : ""}`;
  const suffix = closeHasOwnLine ? newline : `${newline}${closingIndent}`;
  return `${before}${prefix}${entry}${suffix}${updated.slice(insertionPoint)}`;
}

function matchingArrayClose(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].type === "[") depth += 1;
    if (tokens[index].type === "]") depth -= 1;
    if (depth === 0) return index;
  }
  throw new SyntaxError("Unterminated plugin array in OpenCode config");
}

function appendRootPlugin(source, tokens, plugins) {
  let depth = 0;
  let closeIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type === "{") depth += 1;
    if (tokens[index].type === "}") {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        break;
      }
    }
  }
  if (closeIndex === -1) throw new SyntaxError("Unterminated OpenCode config object");

  const closeToken = tokens[closeIndex];
  const previousToken = tokens[closeIndex - 1];
  const closeIndent = lineIndentAt(source, closeToken.start);
  const propertyIndent = `${closeIndent}  `;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const property = `${propertyIndent}"plugin": ${formatPluginArray(plugins, `${propertyIndent}  `, propertyIndent, newline)}`;

  let updated = source;
  let closeStart = closeToken.start;
  if (previousToken?.type !== "{" && previousToken?.type !== ",") {
    updated = `${updated.slice(0, previousToken.end)},${updated.slice(previousToken.end)}`;
    closeStart += 1;
  }

  const lineStart = updated.lastIndexOf("\n", closeStart - 1) + 1;
  const closeHasOwnLine = /^\s*$/u.test(updated.slice(lineStart, closeStart));
  const insertionPoint = closeHasOwnLine ? lineStart : closeStart;
  const before = updated.slice(0, insertionPoint);
  const prefix = before.endsWith("\n") ? "" : newline;
  const suffix = closeHasOwnLine ? newline : `${newline}${closeIndent}`;
  return `${before}${prefix}${property}${suffix}${updated.slice(insertionPoint)}`;
}

function formatPluginArray(plugins, elementIndent, closingIndent, newline) {
  if (plugins.length === 0) return "[]";
  const entries = plugins.map((entry) => `${elementIndent}${JSON.stringify(entry)}`).join(`,${newline}`);
  return `[${newline}${entries}${newline}${closingIndent}]`;
}

function lineIndentAt(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const indent = source.slice(lineStart, index);
  return /^\s*$/u.test(indent) ? indent : "  ";
}

function tokenizeJsonc(input) {
  const tokens = [];
  for (let index = 0; index < input.length;) {
    const char = input[index];
    const next = input[index + 1];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = input.indexOf("*/", index + 2);
      if (end === -1) throw new SyntaxError("Unterminated block comment in JSONC input");
      index = end + 2;
      continue;
    }
    if (char === "\"") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < input.length) {
        const current = input[index];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "\"") {
          index += 1;
          break;
        }
        index += 1;
      }
      const raw = input.slice(start, index);
      tokens.push({ type: "string", value: JSON.parse(raw), start, end: index });
      continue;
    }
    if ("{}[]:,".includes(char)) {
      tokens.push({ type: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    const start = index;
    while (index < input.length && !/[\s{}\[\]:,]/u.test(input[index])) index += 1;
    tokens.push({ type: "value", start, end: index });
  }
  return tokens;
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      if (i >= input.length) throw new SyntaxError("Unterminated block comment in JSONC input");
      i += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function stripTrailingCommas(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let nextIndex = i + 1;
      while (nextIndex < input.length && /\s/u.test(input[nextIndex])) nextIndex += 1;
      if (input[nextIndex] === "}" || input[nextIndex] === "]") continue;
    }
    output += char;
  }
  return output;
}
