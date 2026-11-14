import { IsObject } from 'class-validator';

export class SetDeviceConfigurationDto {
  /** Valores por nombre de parámetro; se validan contra la configuración declarada por el plugin. */
  @IsObject()
  values: Record<string, unknown>;
}
