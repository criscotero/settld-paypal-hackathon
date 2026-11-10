import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./http/configure-app.js";

const DEFAULT_PORT = 4000; // openapi.yaml: servers

// AppModule.forRoot validates the whole environment (including ADR-0001/0003) before
// Nest builds anything: a bad configuration never gets to listen.
const app = await NestFactory.create(AppModule.forRoot(process.env));
configureApp(app);
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? DEFAULT_PORT);
