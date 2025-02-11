export interface TransactionContext<ReturnType = any> {
    /**
     * Execute a query.
     * @param query
     * @param params
     */
    execute(query: string, params?: any[]): Promise<ReturnType>;
}