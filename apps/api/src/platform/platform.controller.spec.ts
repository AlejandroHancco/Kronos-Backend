import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PlatformController } from './platform.controller';

describe('PlatformController', () => {
  it('validates :userId of removeAdmin with ParseUUIDPipe (400 instead of 500)', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, PlatformController, 'removeAdmin');
    const userIdArg: any = Object.values(args).find((a: any) => a.data === 'userId');
    expect(userIdArg.pipes).toContain(ParseUUIDPipe);
  });
});
