import { Button } from "@/components/ui/button";
import { EnvelopeIcon } from "@heroicons/react/16/solid";

export default function Home() {
  return (
    <div className="relative isolate overflow-hidden bg-gray-900 min-h-screen">
      <svg
        aria-hidden="true"
        className="absolute inset-0 -z-10 size-full stroke-white/10 [mask-image:radial-gradient(100%_100%_at_top_right,white,transparent)]"
      >
        <defs>
          <pattern
            x="50%"
            y={-1}
            id="983e3e4c-de6d-4c3f-8d64-b9761d1534cc"
            width={200}
            height={200}
            patternUnits="userSpaceOnUse"
          >
            <path d="M.5 200V.5H200" fill="none" />
          </pattern>
        </defs>
        <svg x="50%" y={-1} className="overflow-visible fill-gray-800/20">
          <title>Background pattern</title>
          <path
            d="M-200 0h201v201h-201Z M600 0h201v201h-201Z M-400 600h201v201h-201Z M200 800h201v201h-201Z"
            strokeWidth={0}
          />
        </svg>
        <rect fill="url(#983e3e4c-de6d-4c3f-8d64-b9761d1534cc)" width="100%" height="100%" strokeWidth={0} />
      </svg>
      <div
        aria-hidden="true"
        className="absolute left-[calc(50%-4rem)] top-10 -z-10 transform-gpu blur-3xl sm:left-[calc(50%-18rem)] lg:left-48 lg:top-[calc(50%-30rem)] xl:left-[calc(50%-24rem)]"
      >
        <div
          style={{
            clipPath:
              'polygon(73.6% 51.7%, 91.7% 11.8%, 100% 46.4%, 97.4% 82.2%, 92.5% 84.9%, 75.7% 64%, 55.3% 47.5%, 46.5% 49.4%, 45% 62.9%, 50.3% 87.2%, 21.3% 64.1%, 0.1% 100%, 5.4% 51.1%, 21.4% 63.9%, 58.9% 0.2%, 73.6% 51.7%)',
          }}
          className="aspect-[1108/632] w-[69.25rem] bg-gradient-to-r from-[#80caff] to-[#4f46e5] opacity-20"
        />
      </div>
      <div className="mx-auto max-w-7xl px-6 pb-24 pt-10 sm:pb-32 lg:flex lg:px-8 lg:py-40 flex items-center justify-center min-h-screen">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="mt-10 text-pretty text-3xl font-semibold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-red-100 to-blue-500 sm:text-5xl">
            The Future of Simple, Scalable Container Deployment
          </h1>
          <p className="mt-8 text-pretty text-lg font-medium text-gray-400 sm:text-xl/8">
            A seamless way to run and manage your apps with high availability and automatic failover. Built for speed, reliability, and control.
          </p>
          <div className="mt-10 flex items-center justify-center gap-x-6">
            <Button
              color="rose"
              href="mailto:cloud+invite@techulus.com"
            >
              <EnvelopeIcon  />
              Request Invite
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
