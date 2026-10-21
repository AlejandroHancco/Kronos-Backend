/** Comandos SCPI de texto sobre la red (IEEE 488.2): Kronos solo habla TCP; GPIB/serie van detrás de un adaptador. */
export interface ScpiTransport {
  /** Envía un comando sin esperar respuesta. */
  write(command: string): Promise<void>;
  /** Envía una consulta y devuelve la línea de respuesta (sin terminador). */
  query(command: string, timeoutMs?: number): Promise<string>;
  close(): void;
}
