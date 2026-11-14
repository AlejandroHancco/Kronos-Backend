import type { PrismaService } from '@app/database';

/** Dispositivos que ocupa una configuración de tarea; el MUX es opcional (null = sin MUX). */
export interface PrefDevices { sensorDeviceId: string; channelSelectorDeviceId: string | null }

export function deviceIdsOf(p: PrefDevices): string[] {
  return p.channelSelectorDeviceId ? [p.sensorDeviceId, p.channelSelectorDeviceId] : [p.sensorDeviceId];
}

/** true si dos configuraciones comparten algún dispositivo físico (nunca por coincidir en "sin MUX"). */
export function sharesDevice(a: PrefDevices, b: PrefDevices): boolean {
  const ids = new Set(deviceIdsOf(a));
  return deviceIdsOf(b).some((id) => ids.has(id));
}

/** IDs de dispositivos (analizador + MUX) usados por jobs programados con status 'running'. */
export async function runningJobDeviceIds(prisma: Pick<PrismaService, 'scheduledJob' | 'taskPreference'>): Promise<Set<string>> {
  const runningJobs = await prisma.scheduledJob.findMany({
    where: { status: 'running' },
    select: { taskId: true },
  });

  const busy = new Set<string>();
  if (runningJobs.length === 0) return busy;

  const preferences = await prisma.taskPreference.findMany({
    where: { taskId: { in: runningJobs.map((j) => j.taskId) } },
    select: { sensorDeviceId: true, channelSelectorDeviceId: true },
  });

  for (const pref of preferences) {
    deviceIdsOf(pref).forEach((id) => busy.add(id));
  }
  return busy;
}
