"use client";

import {
	createContext,
	useContext,
	useEffect,
	useId,
	useCallback,
	useMemo,
	useState,
	type ReactNode,
} from "react";

export type BreadcrumbKey = "project" | "service" | "server" | "build";
export type BreadcrumbData = Partial<Record<BreadcrumbKey, string>>;

type BreadcrumbContextType = {
	data: BreadcrumbData;
	upsertContribution: (id: string, data: BreadcrumbData) => void;
	removeContribution: (id: string) => void;
};

const BreadcrumbDataContext = createContext<BreadcrumbContextType>({
	data: {},
	upsertContribution: () => {},
	removeContribution: () => {},
});

export function BreadcrumbDataProvider({ children }: { children: ReactNode }) {
	const [contributions, setContributions] = useState<
		Record<string, BreadcrumbData>
	>({});

	const upsertContribution = useCallback((id: string, data: BreadcrumbData) => {
		setContributions((prev) => {
			const existing = prev[id];
			if (existing === data) return prev;
			return { ...prev, [id]: data };
		});
	}, []);

	const removeContribution = useCallback((id: string) => {
		setContributions((prev) => {
			if (!(id in prev)) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
	}, []);

	const mergedData = useMemo(() => {
		return Object.values(contributions).reduce(
			(acc, contribution) => ({ ...acc, ...contribution }),
			{} as BreadcrumbData,
		);
	}, [contributions]);

	return (
		<BreadcrumbDataContext.Provider
			value={{ data: mergedData, upsertContribution, removeContribution }}
		>
			{children}
		</BreadcrumbDataContext.Provider>
	);
}

export function useBreadcrumbData() {
	return useContext(BreadcrumbDataContext).data;
}

export function useBreadcrumbSetter(data: BreadcrumbData) {
	const id = useId();
	const { upsertContribution, removeContribution } = useContext(
		BreadcrumbDataContext,
	);

	useEffect(() => {
		upsertContribution(id, data);
		return () => removeContribution(id);
	}, [id, data, upsertContribution, removeContribution]);
}

export function SetBreadcrumbData({ data }: { data: BreadcrumbData }) {
	useBreadcrumbSetter(data);
	return null;
}
