import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import chatRouter from "./chat";
import authRouter from "./auth";
import reporterRouter from "./reporter";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botRouter);
router.use(chatRouter);
router.use(authRouter);
router.use(reporterRouter);

export default router;
