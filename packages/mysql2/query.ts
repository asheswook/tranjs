import { ParameterWithNames, ParametrizedQuery, QueryParser} from "@tranjs/core";

export class MySQLQueryParser implements QueryParser {
    parse(query: string): ParametrizedQuery {
        if (!query.includes(':')) {
            return {
                query,
                paramNames: [],
            }
        }

        const paramNames = query.match(/:[a-zA-Z0-9_]+/g)!.map((name) => name.slice(1));

        return {
            query: query.replace(/:[a-zA-Z0-9_]+/g, '?'),
            paramNames,
        }
    }
}