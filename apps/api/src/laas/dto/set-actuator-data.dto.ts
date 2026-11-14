import { IsObject } from 'class-validator';

/** Cuerpo de setActuatorData: `{ values: { <nombre del actuatorValue>: número } }`. */
export class SetActuatorDataDto {
  /** Forma (objeto no vacío de números) en LaasInstancesService; rangos en el worker. */
  @IsObject()
  values: Record<string, number>;
}
