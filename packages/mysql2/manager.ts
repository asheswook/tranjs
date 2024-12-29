import { TransactionManager } from "@node-transaction/core";
import {MySQLUnitOfWork} from "./unitOfWork";

export const MySQLTransactionManager = TransactionManager<MySQLUnitOfWork>;