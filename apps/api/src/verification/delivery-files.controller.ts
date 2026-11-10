// uploadDeliveryFile and downloadDeliveryFile (openapi.yaml 0.18.0, ADR-0020).
import { Controller, Get, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { OnboardedGuard } from "../auth/onboarded.guard.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { uuidParam } from "../http/params.js";
import { requestIdOf } from "../http/request-id.js";
import { DeliveryFilesService } from "./delivery-files.service.js";
import type { UploadedFile as Uploaded } from "./delivery-files.service.js";
import { MAX_ZIP_BYTES } from "./zip-check.js";

@Controller()
export class DeliveryFilesController {
  constructor(private readonly files: DeliveryFilesService) {}

  // In memory (Multer's default without `dest`), never on disk under the seller's name: the file is
  // checked before it is kept.
  // The multer cap is twice the contract's limit only to bound memory; the service answers the
  // contract's FILE_TOO_LARGE for anything over 25 MB.
  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId/delivery-files")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 2 * MAX_ZIP_BYTES, files: 1, fields: 0 } }))
  async upload(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("milestoneId") id: string, @UploadedFile() file: Uploaded | undefined) {
    const view = await this.files.upload(uuidParam(id), { user, requestId: requestIdOf(req) }, file);
    res.status(201);
    return view;
  }

  @Get("milestones/:milestoneId/delivery-files/:fileId")
  async download(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res() res: Response, @Param("milestoneId") id: string, @Param("fileId") fileId: string) {
    const { path, row } = await this.files.download(uuidParam(id), uuidParam(fileId), { user, requestId: requestIdOf(req) });
    // Always an attachment with a fixed type: an HTML or SVG inside a seller's upload must never
    // render as a page of Settld's API origin.
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.attachment(row.name.endsWith(".zip") ? row.name : `${row.name}.zip`);
    res.sendFile(path, (error) => {
      if (error !== undefined && !res.headersSent) res.status(404).end();
    });
  }
}
