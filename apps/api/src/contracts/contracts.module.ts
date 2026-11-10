import { Module } from "@nestjs/common";
import { ContractsController } from "./contracts.controller.js";
import { ContractsService } from "./contracts.service.js";
import { OpenProjectsController } from "./open-projects.controller.js";
import { OpenProjectsService } from "./open-projects.service.js";
import { INVITATION_SENDER, InvitationsService, LoggingInvitationSender } from "./invitations.service.js";

@Module({
  controllers: [ContractsController, OpenProjectsController],
  providers: [ContractsService, InvitationsService, OpenProjectsService, { provide: INVITATION_SENDER, useClass: LoggingInvitationSender }],
})
export class ContractsModule {}
