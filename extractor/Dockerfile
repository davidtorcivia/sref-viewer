# REFS BUFR extractor: decodes NCEP member sounding BUFR files
# (class1fv3) into JSON time series using NCEPLIBS-bufr's debufr.
FROM debian:bookworm-slim AS build
RUN apt-get update -qq && apt-get install -y -qq gcc gfortran cmake make curl ca-certificates >/dev/null
RUN curl -sfL https://github.com/NOAA-EMC/NCEPLIBS-bufr/archive/refs/tags/v12.1.0.tar.gz | tar xz -C /tmp
RUN cmake -S /tmp/NCEPLIBS-bufr-12.1.0 -B /tmp/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/bufr >/dev/null \
    && cmake --build /tmp/build -j4 >/dev/null 2>&1 \
    && cmake --install /tmp/build >/dev/null

FROM debian:bookworm-slim
# dpkg-dev: Debian's python3-eccodes runs dpkg-architecture at import time
RUN apt-get update -qq && apt-get install -y -qq libgfortran5 python3 python3-eccodes dpkg-dev ca-certificates >/dev/null \
    && apt-get clean
# Full install tree - debufr needs its master table files, not just the binary
COPY --from=build /opt/bufr /opt/bufr
ENV PATH="/opt/bufr/bin:${PATH}"
COPY extractor.py /app/extractor.py
ENV PORT=3002
EXPOSE 3002
CMD ["python3", "/app/extractor.py"]
