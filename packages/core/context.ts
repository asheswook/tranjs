export interface TransactionContext {
    /**
     * Execute a query. Params are optional, 원본 라이브러리에 따라서 Escape 처리를 수동으로 해주어야 하는 경우 또는 형식이 맞지 않는 경우가 있을 수 있기 때문에
     * @param query
     * @param params
     */
    execute(query: string, params?: any[]): Promise<any>;
}