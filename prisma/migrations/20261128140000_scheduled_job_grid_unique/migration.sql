-- Una fila por punto de rejilla (tarea, origen de la serie, posición): el scheduler crea la
-- siguiente repetición y las filas missed ignorando el choque, así un reinicio nunca duplica.
-- Antes, elimina pendientes duplicados que pudieran existir (se conserva el de menor id);
-- un pendiente no tiene mediciones, igual que al borrarlo desde la API.
DELETE FROM "platform"."scheduled_jobs" d
WHERE d.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM "platform"."scheduled_jobs" o
    WHERE o."taskId" = d."taskId"
      AND o."seriesStartAt" = d."seriesStartAt"
      AND o."executionIndex" = d."executionIndex"
      AND (o.status <> 'pending' OR o.id < d.id)
  );

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_taskId_seriesStartAt_executionIndex_key" ON "platform"."scheduled_jobs"("taskId", "seriesStartAt", "executionIndex");
