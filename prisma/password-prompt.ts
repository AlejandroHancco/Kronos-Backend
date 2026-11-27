// Pure validation, mirrors the app rules: >= 8 chars and <= 72 UTF-8 bytes (bcrypt limit).
export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (Buffer.byteLength(pw, 'utf8') > 72) {
    return 'La contraseña no puede superar 72 bytes (UTF-8).';
  }
  return null;
}

// Reads a line from a TTY without echoing it. Ctrl+C aborts the process.
export function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error(
        'stdin no es un terminal interactivo. Ejecuta con docker exec -it.',
      ),
    );
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onExit = () => {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    };
    process.once('exit', onExit);
    const onData = (chunk: string) => {
      // Escape sequences (arrows, Home, Delete, F-keys): ignore the whole chunk.
      if (chunk.startsWith('001b')) return;
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          buf = Array.from(buf).slice(0, -1).join('');
        } else if (ch >= ' ') {
          buf += ch;
        }
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      process.removeListener('exit', onExit);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
