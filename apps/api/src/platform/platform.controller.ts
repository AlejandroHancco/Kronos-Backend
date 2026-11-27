import { Body, Controller, Delete, Get, HttpCode, Param, Post, Request, UseGuards } from '@nestjs/common';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformService } from './platform.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { AddAdminDto } from './dto/add-admin.dto';

/** API del superadministrador: grupos de investigación y sus administradores. */
@Controller('platform')
@UseGuards(CombinedAuthGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('teams')
  listTeams() {
    return this.platform.listTeams();
  }

  @Post('teams')
  createTeam(@Body() body: CreateTeamDto, @Request() req: any) {
    return this.platform.createTeam(body, req.user.id);
  }

  @Post('teams/:id/admins')
  @HttpCode(200)
  addAdmin(@Param('id') id: string, @Body() body: AddAdminDto, @Request() req: any) {
    return this.platform.addAdmin(id, body.email, req.user.id);
  }

  @Delete('teams/:id/admins/:userId')
  @HttpCode(204)
  async removeAdmin(@Param('id') id: string, @Param('userId') userId: string) {
    await this.platform.removeAdmin(id, userId);
  }

  @Delete('grants/:id')
  @HttpCode(204)
  async revokeGrant(@Param('id') id: string) {
    await this.platform.revokeGrant(id);
  }
}
