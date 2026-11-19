import { z } from "zod";
import { parseTaskMoneyV1, type TaskMoneyV1 } from "./task-money.js";
export const TaskMoneyV1Schema = z.custom<TaskMoneyV1>(value => parseTaskMoneyV1(value) !== undefined);
